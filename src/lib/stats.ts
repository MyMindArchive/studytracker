import { addWeeks, endOfWeek, startOfDay, subDays } from "date-fns";
import type { DbNode, PctHistory, Session } from "../types";
import { computeRollup, hoursPerUnit, subjectIndex, type NodeRollup } from "./rollup";
import type { RollupMode } from "../types";
import { bucketKey, dayKey, fromIso, listWeekStarts, streak, weekKey, weekStart, WEEK_STARTS_ON } from "./time";

export const UNASSIGNED = "Unassigned";

const H = 3600;

/* ------------------------------------------------------------- helpers */

export function sessionHours(s: Session): number {
  return s.actual_seconds / H;
}

/** Sessions that count toward time: anything with actual seconds > 0. */
export function creditedSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.actual_seconds > 0);
}

/* --------------------------------------------------------------- today */

export function hoursToday(sessions: Session[], now = new Date()): number {
  const k = dayKey(now);
  let total = 0;
  for (const s of creditedSessions(sessions)) if (dayKey(fromIso(s.started_at)) === k) total += sessionHours(s);
  return total;
}

/* ---------------------------------------------------------- this week */

export interface SubjectWeek {
  subjectId: string;
  name: string;
  color: string | null;
  hours: number;
  target: number | null;
  behindTwoWeeks: boolean;
}

export function hoursBySubjectForWeek(nodes: DbNode[], sessions: Session[], anyDayInWeek: Date): Map<string, number> {
  const subj = subjectIndex(nodes);
  const wk = weekKey(anyDayInWeek);
  const out = new Map<string, number>();
  for (const s of creditedSessions(sessions)) {
    if (weekKey(fromIso(s.started_at)) !== wk) continue;
    const subjectId = s.node_id ? (subj.get(s.node_id)?.id ?? UNASSIGNED) : UNASSIGNED;
    out.set(subjectId, (out.get(subjectId) ?? 0) + sessionHours(s));
  }
  return out;
}

export function thisWeekBySubject(nodes: DbNode[], sessions: Session[], now = new Date()): SubjectWeek[] {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const cur = hoursBySubjectForWeek(nodes, sessions, now);
  const prev1 = hoursBySubjectForWeek(nodes, sessions, addWeeks(now, -1));
  const prev2 = hoursBySubjectForWeek(nodes, sessions, addWeeks(now, -2));
  return subjects.map((s) => {
    const target = s.weekly_target_hours;
    const behind =
      target != null && target > 0 && (prev1.get(s.id) ?? 0) < target && (prev2.get(s.id) ?? 0) < target;
    return {
      subjectId: s.id,
      name: s.name,
      color: s.color,
      hours: cur.get(s.id) ?? 0,
      target,
      behindTwoWeeks: behind,
    };
  });
}

/* ------------------------------------------------------- time series */

export interface TimeSeries {
  /** series keys in display order; last one is Unassigned */
  keys: { key: string; name: string; color: string | null }[];
  rows: Array<Record<string, number | string>>; // { bucket, [key]: hours }
}

export function timeBySubject(
  nodes: DbNode[],
  sessions: Session[],
  period: "day" | "week" | "month",
  now = new Date(),
  span?: number,
): TimeSeries {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const subj = subjectIndex(nodes);
  const count = span ?? (period === "day" ? 14 : period === "week" ? 12 : 12);

  // Build bucket list ending at now
  const buckets: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    let d: Date;
    if (period === "day") d = subDays(now, i);
    else if (period === "week") d = addWeeks(now, -i);
    else d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push(bucketKey(d, period));
  }
  const rowsByBucket = new Map<string, Record<string, number | string>>();
  for (const b of buckets) {
    const row: Record<string, number | string> = { bucket: b };
    for (const s of subjects) row[s.id] = 0;
    row[UNASSIGNED] = 0;
    rowsByBucket.set(b, row);
  }
  for (const s of creditedSessions(sessions)) {
    const b = bucketKey(fromIso(s.started_at), period);
    const row = rowsByBucket.get(b);
    if (!row) continue;
    const key = s.node_id ? (subj.get(s.node_id)?.id ?? UNASSIGNED) : UNASSIGNED;
    row[key] = ((row[key] as number) ?? 0) + sessionHours(s);
  }
  return {
    keys: [
      ...subjects.map((s) => ({ key: s.id, name: s.name, color: s.color })),
      { key: UNASSIGNED, name: UNASSIGNED, color: null },
    ],
    rows: buckets.map((b) => rowsByBucket.get(b)!),
  };
}

/* ------------------------------------------------- planned vs actual */

export interface PlannedActualRow {
  id: string;
  name: string;
  level: "subject" | "leaf";
  subjectId: string;
  subjectName: string;
  color: string | null;
  estHours: number | null;
  hoursLogged: number;
  pct: number;
  /** hours logged exceed estimate while pct < 80 */
  overrun: boolean;
}

/** Hours logged per node, including descendants. */
export function hoursByNodeInclusive(nodes: DbNode[], sessions: Session[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number>();
  for (const s of creditedSessions(sessions)) {
    if (!s.node_id) continue;
    let cur: DbNode | undefined = byId.get(s.node_id);
    while (cur) {
      out.set(cur.id, (out.get(cur.id) ?? 0) + sessionHours(s));
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  return out;
}

export function plannedVsActual(nodes: DbNode[], sessions: Session[], roll?: Map<string, NodeRollup>): PlannedActualRow[] {
  const r = roll ?? computeRollup(nodes);
  const subj = subjectIndex(nodes);
  const hours = hoursByNodeInclusive(nodes, sessions);
  const rows: PlannedActualRow[] = [];
  for (const n of nodes) {
    const rr = r.get(n.id);
    if (!rr) continue;
    const isSubject = n.parent_id === null;
    if (!isSubject && !rr.isLeaf) continue;
    const subject = subj.get(n.id)!;
    const f = hoursPerUnit(subject);
    const estHours = f == null ? null : rr.estTotal * f;
    const logged = hours.get(n.id) ?? 0;
    rows.push({
      id: n.id,
      name: n.name,
      level: isSubject ? "subject" : "leaf",
      subjectId: subject.id,
      subjectName: subject.name,
      color: subject.color,
      estHours,
      hoursLogged: logged,
      pct: rr.pct,
      overrun: estHours != null && estHours > 0 && logged > estHours && rr.pct < 80,
    });
  }
  return rows;
}

/* ----------------------------------------------------------- velocity */

/**
 * How far back the pace looks. Work older than this should not keep holding a
 * project's forecast down once the pace has changed.
 */
export const PACE_WINDOW_WEEKS = 6;
/**
 * Below this much real history there is nothing to average, so the pace is
 * withheld rather than guessed. Dividing 30 % by half a day of history once
 * produced "420 pts/wk, done tomorrow" — a confident-looking number resting
 * on one data point.
 */
export const MIN_PACE_DAYS = 3;
const DAY_MS = 86_400_000;
/**
 * Chart window when none is given: wide enough to hold the oldest project,
 * but clamped. Projects here run from a fortnight to a few months, so a fixed
 * 8 weeks either squeezes a long one or strands a short one in a sliver at the
 * right edge.
 */
const MIN_CHART_WEEKS = 5;
const MAX_CHART_WEEKS = 26;

/** How much history the pace rests on. */
export type VelocityConfidence = "none" | "thin" | "fair" | "good";

export interface VelocityRow {
  subjectId: string;
  name: string;
  color: string | null;
  currentPct: number;
  /** pct at the end of each week (oldest first); null for weeks before the project existed */
  weekly: { week: string; pct: number | null }[];
  /** percentage points per week, measured over `basisWeeks` — never over empty weeks before the start */
  velocity: number;
  /** pace counting only the weeks that actually moved */
  activePace: number;
  /** percentage points gained over the measured span */
  gained: number;
  /** length of the measured span in weeks (fractional); starts at the project, not 8 weeks ago */
  basisWeeks: number;
  /** whole weeks inside the span that moved forward */
  activeWeeks: number;
  /** weeks to 100 at `velocity`; 0 when done, null when stalled or going backwards */
  forecastWeeks: number | null;
  /** projected finish date; null whenever `forecastWeeks` is */
  etaDate: Date | null;
  confidence: VelocityConfidence;
  /** what the finish column should say, so the UI does not re-derive it */
  status: VelocityStatus;
  /** first moment this project had anything to measure */
  startedAt: Date | null;
}

/**
 *  done     already at 100
 *  too-new  less than MIN_PACE_DAYS of history — no honest rate exists yet
 *  stalled  enough history, but nothing moved forward
 *  ok       a real pace, so a finish date can be projected
 */
export type VelocityStatus = "done" | "too-new" | "stalled" | "ok";

/**
 * Earliest moment each node is known to have existed: its `created_at`, an
 * older percent-history row if one exists (imported data can disagree), or the
 * birth of its earliest descendant — a parent cannot post-date its own child.
 */
function birthTimes(nodes: DbNode[], history: PctHistory[]): Map<string, number> {
  const born = new Map<string, number>();
  for (const n of nodes) {
    const t = fromIso(n.created_at).getTime();
    born.set(n.id, Number.isFinite(t) ? t : 0);
  }
  for (const h of history) {
    const t = fromIso(h.changed_at).getTime();
    if (!Number.isFinite(t)) continue;
    const cur = born.get(h.node_id);
    if (cur === undefined || t < cur) born.set(h.node_id, t);
  }
  // Pull every ancestor back to its earliest descendant, so a snapshot that
  // keeps a task never drops the project it hangs under.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const t = born.get(n.id)!;
    let p = n.parent_id;
    const seen = new Set<string>([n.id]);
    while (p && !seen.has(p)) {
      seen.add(p);
      const cur = born.get(p);
      if (cur !== undefined && cur <= t) break;
      born.set(p, t);
      p = byId.get(p)?.parent_id ?? null;
    }
  }
  return born;
}

/**
 * Rebuild leaf pct as of a timestamp using pct_history (0 if no history yet).
 * Tasks that did not exist yet are left out: a task added today sitting at 0 %
 * would otherwise be folded into every past week, dragging the old percentages
 * down and making the project look like it suddenly sped up.
 */
export function pctAsOf(nodes: DbNode[], history: PctHistory[], at: Date, born?: Map<string, number>): DbNode[] {
  const t = at.getTime();
  const birth = born ?? birthTimes(nodes, history);
  const latest = new Map<string, { t: number; pct: number }>();
  for (const h of history) {
    const ht = fromIso(h.changed_at).getTime();
    if (ht > t) continue;
    const cur = latest.get(h.node_id);
    if (!cur || ht >= cur.t) latest.set(h.node_id, { t: ht, pct: h.pct });
  }
  return nodes
    .filter((n) => (birth.get(n.id) ?? 0) <= t)
    .map((n) => ({ ...n, pct_complete: latest.get(n.id)?.pct ?? 0 }));
}

/**
 * Pace and finish date per project.
 *
 * The pace is `points gained ÷ time it took`, measured from whichever is later:
 * the moment the project started, or `PACE_WINDOW_WEEKS` ago. Weeks before a
 * project existed are never averaged in — that is what used to turn "35 % in
 * one week" into "8 weeks to go" (a 35-point jump divided across four weeks,
 * three of which the project did not exist for).
 *
 * Idle weeks *after* the start still count, because a month off is a real part
 * of how fast a project is moving; `activePace` reports the other reading.
 */
export function velocity(nodes: DbNode[], history: PctHistory[], sessions: Session[] = [], now = new Date(), weeks?: number, mode?: RollupMode): VelocityRow[] {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const current = computeRollup(nodes, mode);
  const born = birthTimes(nodes, history);
  const subjOf = subjectIndex(nodes);
  const nowMs = now.getTime();

  // When each project first had anything to measure. Logged time counts as
  // evidence of a start: backfilling hours from three weeks ago says the work
  // began then, even though the project row was typed into the app today.
  const startOf = new Map<string, number>();
  const noteStart = (sid: string | undefined, t: number) => {
    if (!sid || !Number.isFinite(t)) return;
    const cur = startOf.get(sid);
    if (cur === undefined || t < cur) startOf.set(sid, t);
  };
  for (const n of nodes) noteStart(subjOf.get(n.id)?.id, born.get(n.id) ?? nowMs);
  for (const ss of creditedSessions(sessions)) {
    if (!ss.node_id) continue; // inbox time belongs to no project yet
    noteStart(subjOf.get(ss.node_id)?.id, fromIso(ss.started_at).getTime());
  }

  // Fit the window to the oldest project so a two-week project fills the chart
  // and a five-month one still fits, instead of always drawing eight weeks.
  let span = weeks;
  if (span === undefined) {
    const oldest = startOf.size ? Math.min(...startOf.values()) : nowMs;
    const lived = Math.ceil((nowMs - oldest) / (7 * DAY_MS)) + 1;
    span = Math.max(MIN_CHART_WEEKS, Math.min(MAX_CHART_WEEKS, lived));
  }

  const weekEnds: Date[] = [];
  for (let i = span - 1; i >= 0; i--) {
    weekEnds.push(endOfWeek(addWeeks(now, -i), { weekStartsOn: WEEK_STARTS_ON }));
  }
  const snapshots = weekEnds.map((we) => {
    const at = we.getTime() > nowMs ? now : we;
    return { week: weekKey(we), at: at.getTime(), roll: computeRollup(pctAsOf(nodes, history, at, born), mode) };
  });

  // Several projects usually share the same clamped window start; roll up once each.
  const rollAt = new Map<number, Map<string, NodeRollup>>();
  const rollupAt = (ms: number) => {
    let r = rollAt.get(ms);
    if (!r) {
      r = computeRollup(pctAsOf(nodes, history, new Date(ms), born), mode);
      rollAt.set(ms, r);
    }
    return r;
  };

  return subjects.map((s) => {
    const startedMs = startOf.get(s.id) ?? nowMs;
    const startedAt = startOf.has(s.id) ? new Date(startedMs) : null;
    const weekly = snapshots.map((sn) => ({
      week: sn.week,
      pct: sn.at < startedMs ? null : (sn.roll.get(s.id)?.pct ?? 0),
    }));

    const cur = current.get(s.id)?.pct ?? 0;
    const spanStartMs = Math.max(startedMs, nowMs - PACE_WINDOW_WEEKS * 7 * DAY_MS);
    const pctThen = rollupAt(spanStartMs).get(s.id)?.pct ?? 0;
    const gained = cur - pctThen;
    const spanDays = Math.max(0, (nowMs - spanStartMs) / DAY_MS);
    const basisWeeks = spanDays / 7;
    const tooNew = spanDays < MIN_PACE_DAYS;
    const v = tooNew ? 0 : gained / basisWeeks;

    let activeWeeks = 0;
    for (let i = 1; i < weekly.length; i++) {
      if (snapshots[i].at < spanStartMs) continue;
      const b = weekly[i].pct;
      if (b === null) continue;
      if (b - (weekly[i - 1].pct ?? 0) > 0.05) activeWeeks++;
    }
    // All of the gain can land inside a single part-week that has no delta yet.
    if (activeWeeks === 0 && gained > 0.05) activeWeeks = 1;
    const activePace = activeWeeks > 0 ? gained / activeWeeks : 0;

    const status: VelocityStatus = cur >= 100 ? "done" : tooNew ? "too-new" : v > 0 ? "ok" : "stalled";
    const forecastWeeks = status === "done" ? 0 : status === "ok" ? (100 - cur) / v : null;
    const etaDate = forecastWeeks === null || forecastWeeks === 0 ? null : new Date(nowMs + forecastWeeks * 7 * DAY_MS);
    const confidence: VelocityConfidence =
      tooNew || gained <= 0.05
        ? "none"
        : basisWeeks < 1 || activeWeeks <= 1
          ? "thin"
          : basisWeeks >= 3 && activeWeeks >= 3
            ? "good"
            : "fair";

    return {
      subjectId: s.id,
      name: s.name,
      color: s.color,
      currentPct: cur,
      weekly,
      velocity: v,
      activePace,
      gained,
      basisWeeks,
      activeWeeks,
      forecastWeeks,
      etaDate,
      confidence,
      status,
      startedAt,
    };
  });
}


/* ------------------------------------------------------ session stats */

export interface SessionStats {
  count: number;
  avgSeconds: number;
  completionRate: number; // 0..1
  streakDays: number;
  /** heatmap[dow][hour] hours, dow 0 = Monday */
  heatmap: number[][];
  totalHours: number;
}

export function sessionStats(sessions: Session[], now = new Date()): SessionStats {
  const credited = creditedSessions(sessions);
  const count = sessions.length;
  const completed = sessions.filter((s) => s.ended_reason === "completed").length;
  const avg = credited.length ? credited.reduce((a, s) => a + s.actual_seconds, 0) / credited.length : 0;
  const days = new Set(credited.map((s) => dayKey(fromIso(s.started_at))));
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of credited) {
    // spread the session across the hours it spans
    let remaining = s.actual_seconds;
    let cursor = fromIso(s.started_at);
    while (remaining > 0) {
      const hourEnd = new Date(cursor);
      hourEnd.setMinutes(60, 0, 0);
      const chunk = Math.min(remaining, (hourEnd.getTime() - cursor.getTime()) / 1000);
      const dow = (cursor.getDay() + 6) % 7; // Monday=0
      heat[dow][cursor.getHours()] += chunk / H;
      remaining -= chunk;
      cursor = hourEnd;
    }
  }
  return {
    count,
    avgSeconds: avg,
    completionRate: count ? completed / count : 0,
    streakDays: streak(days, now),
    heatmap: heat,
    totalHours: credited.reduce((a, s) => a + sessionHours(s), 0),
  };
}

/* ------------------------------------------------------ weekly summary */

export interface WeeklySummaryRow {
  week_start: string;
  subject: string;
  hours_logged: number;
  weekly_target: number | null;
  variance: number | null;
  pct_complete_end_of_week: number | null;
  pct_change: number | null;
}

export function weeklySummary(nodes: DbNode[], sessions: Session[], history: PctHistory[], now = new Date(), mode?: RollupMode): WeeklySummaryRow[] {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const subj = subjectIndex(nodes);
  const credited = creditedSessions(sessions);
  const timestamps = [...credited.map((s) => fromIso(s.started_at)), ...history.map((h) => fromIso(h.changed_at))];
  if (subjects.length === 0 && timestamps.length === 0) return [];
  const earliest = timestamps.length ? new Date(Math.min(...timestamps.map((d) => d.getTime()))) : now;
  const weeks = listWeekStarts(earliest, now);

  // hours per (week, subjectKey)
  const hours = new Map<string, number>();
  for (const s of credited) {
    const wk = weekKey(fromIso(s.started_at));
    const key = s.node_id ? (subj.get(s.node_id)?.id ?? UNASSIGNED) : UNASSIGNED;
    const k = `${wk}|${key}`;
    hours.set(k, (hours.get(k) ?? 0) + sessionHours(s));
  }

  const rows: WeeklySummaryRow[] = [];
  let prevPct = new Map<string, number>();
  for (const ws of weeks) {
    const we = endOfWeek(ws, { weekStartsOn: WEEK_STARTS_ON });
    const at = we.getTime() > now.getTime() ? now : we;
    const roll = computeRollup(pctAsOf(nodes, history, at), mode);
    const wk = weekKey(ws);
    const curPct = new Map<string, number>();
    for (const s of subjects) {
      const pct = roll.get(s.id)?.pct ?? 0;
      curPct.set(s.id, pct);
      const logged = hours.get(`${wk}|${s.id}`) ?? 0;
      const target = s.weekly_target_hours;
      rows.push({
        week_start: wk,
        subject: s.name,
        hours_logged: logged,
        weekly_target: target,
        variance: target != null ? logged - target : null,
        pct_complete_end_of_week: round(pct, 4),
        pct_change: round(pct - (prevPct.get(s.id) ?? 0), 4),
      });
    }
    const un = hours.get(`${wk}|${UNASSIGNED}`) ?? 0;
    if (un > 0) {
      rows.push({
        week_start: wk,
        subject: UNASSIGNED,
        hours_logged: un,
        weekly_target: null,
        variance: null,
        pct_complete_end_of_week: null,
        pct_change: null,
      });
    }
    prevPct = curPct;
  }
  return rows;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------ unassigned */

export function unassignedHours(sessions: Session[]): number {
  return creditedSessions(sessions)
    .filter((s) => !s.node_id)
    .reduce((a, s) => a + sessionHours(s), 0);
}

export function firstDayOf(sessions: Session[]): Date | null {
  if (sessions.length === 0) return null;
  return startOfDay(new Date(Math.min(...sessions.map((s) => fromIso(s.started_at).getTime()))));
}

export { weekStart };
