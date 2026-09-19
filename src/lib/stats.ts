import { addWeeks, endOfWeek, startOfDay, subDays } from "date-fns";
import type { DbNode, PctHistory, Session, SessionSource, StatusHistory } from "../types";
import { computeRollup, childrenOf, hoursPerUnit, subjectIndex, type NodeRollup } from "./rollup";
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

/**
 * Sessions whose start time is a real clock reading. A backfilled entry starts
 * at whatever hour was typed into the dialog (09:00 unless changed), so letting
 * those into an hour-of-day chart draws a habit that does not exist.
 */
export function timedSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.source === "timer" || s.source === "unknown");
}

/* --------------------------------------------------- distributions */

/**
 * Linear-interpolated quantile. Session lengths and task durations are
 * right-skewed — one nine-hour Sunday drags a mean somewhere no day ever was —
 * so everything here is reported as a median and a p85 instead.
 */
export function quantile(values: number[], q: number): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function median(values: number[]): number | null {
  return quantile(values, 0.5);
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
  /** kept for exports; the dashboard shows the median instead */
  avgSeconds: number;
  medianSeconds: number;
  p85Seconds: number;
  /**
   * Share of timer blocks that ran to the end — null when nothing was timed.
   * Backfilled entries are excluded by construction: their planned and actual
   * seconds are the same number, so counting them would only ever add 100 %.
   */
  completionRate: number | null;
  /** how many sessions the completion rate rests on */
  timedCount: number;
  sources: Record<SessionSource, number>;
  daysLogged: number;
  streakDays: number;
  /** heatmap[dow][hour] hours, dow 0 = Monday */
  heatmap: number[][];
  /** timer = real clock times, entered = start times typed by hand, none = empty */
  heatmapBasis: "timer" | "entered" | "none";
  totalHours: number;
}

export function sessionStats(sessions: Session[], now = new Date()): SessionStats {
  const credited = creditedSessions(sessions);
  const count = sessions.length;
  const timed = timedSessions(sessions);
  const completed = timed.filter((s) => s.ended_reason === "completed").length;
  const lengths = credited.map((s) => s.actual_seconds);
  const avg = lengths.length ? lengths.reduce((a, n) => a + n, 0) / lengths.length : 0;
  const days = new Set(credited.map((s) => dayKey(fromIso(s.started_at))));

  const sources = { timer: 0, manual: 0, imported: 0, unknown: 0 } as Record<SessionSource, number>;
  for (const s of credited) sources[s.source] = (sources[s.source] ?? 0) + 1;

  // Prefer real clock readings; fall back to what was typed rather than showing
  // an empty grid, but say which it is so nobody reads a 9 a.m. habit into it.
  const timedCredited = creditedSessions(timed);
  const heatFrom = timedCredited.length ? timedCredited : credited;
  const heatmapBasis: SessionStats["heatmapBasis"] = timedCredited.length ? "timer" : credited.length ? "entered" : "none";

  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of heatFrom) {
    // spread the session across the hours it spans
    let remaining = s.actual_seconds;
    let cursor = localClock(s);
    while (remaining > 0) {
      const hourEnd = new Date(cursor);
      hourEnd.setUTCMinutes(60, 0, 0);
      const chunk = Math.min(remaining, (hourEnd.getTime() - cursor.getTime()) / 1000);
      const dow = (cursor.getUTCDay() + 6) % 7; // Monday=0
      heat[dow][cursor.getUTCHours()] += chunk / H;
      remaining -= chunk;
      cursor = hourEnd;
    }
  }
  return {
    count,
    avgSeconds: avg,
    medianSeconds: median(lengths) ?? 0,
    p85Seconds: quantile(lengths, 0.85) ?? 0,
    completionRate: timed.length ? completed / timed.length : null,
    timedCount: timed.length,
    sources,
    daysLogged: days.size,
    streakDays: streak(days, now),
    heatmap: heat,
    heatmapBasis,
    totalHours: credited.reduce((a, s) => a + sessionHours(s), 0),
  };
}

/**
 * The session's start as a clock face, expressed in UTC fields so the reading
 * never depends on where the machine is now. A row written before v4 has no
 * stored offset, so it falls back to the runtime's zone — the old behaviour.
 */
function localClock(s: Session): Date {
  const t = fromIso(s.started_at);
  if (s.tz_offset == null) return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()));
  return new Date(t.getTime() + s.tz_offset * 60_000);
}

/* ------------------------------------------------------- aging work */

/**
 * Nothing logged and no percent moved for this long counts as idle. Two weeks
 * is long enough to survive an exam week or a holiday without crying wolf.
 */
export const IDLE_DAYS = 14;
/**
 * Work touched this recently is moving, so it is never called "running long".
 * A task you put hours into today does not need attention because it has been
 * open a while — its length already shows up in planned vs actual.
 */
export const ACTIVE_DAYS = 3;
/**
 * Below this many finished comparables a project does not get to set its own
 * yardstick; it borrows the pooled one. Six tasks is not a distribution, and a
 * p85 drawn from three of them is just the slowest of the three.
 */
export const MIN_SUPPORT = 5;

/**
 *  late         past its deadline and not finished
 *  blocked      flagged as waiting on something
 *  overrun      open longer than 85 % of comparable finished tasks took
 *  idle         nothing logged and no percent moved for IDLE_DAYS
 *  not-started  still at 0 % after the day it was meant to begin
 */
export type AgingFlag = "late" | "blocked" | "overrun" | "idle" | "not-started";
const FLAG_ORDER: AgingFlag[] = ["late", "blocked", "overrun", "idle", "not-started"];

export interface AgingRow {
  id: string;
  name: string;
  subjectId: string;
  subjectName: string;
  color: string | null;
  pct: number;
  hoursLogged: number;
  /** first evidence of real work: a logged session or a percent above zero */
  startedAt: Date | null;
  /** most recent of those two, by the day the work happened */
  lastActivityAt: Date | null;
  ageDays: number | null;
  idleDays: number | null;
  /** p85 of how long comparable finished tasks took, in days */
  typicalDays: number | null;
  /** whether that yardstick came from this project or the pooled one */
  typicalFrom: "project" | "all" | null;
  blockedSince: Date | null;
  blockedDays: number | null;
  deadline: Date | null;
  daysToDeadline: number | null;
  plannedStart: Date | null;
  /** most serious first; a row with none of these is not reported */
  flags: AgingFlag[];
}

/** Latest timestamp at which a node's percent reached 100, if it ever did. */
function completionTimes(history: PctHistory[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of history) {
    if (h.pct < 100) continue;
    const t = fromIso(h.changed_at).getTime();
    if (!Number.isFinite(t)) continue;
    const cur = out.get(h.node_id);
    if (cur === undefined || t > cur) out.set(h.node_id, t);
  }
  return out;
}

/**
 * When work on each node actually began and was last touched. Both are read
 * from evidence of work — a logged session or a percent that moved — never
 * from the day the row was typed in, so a task created months ago and started
 * yesterday is one day old, not four months.
 *
 * A session's start is the day the work happened, not the day it was entered.
 * Backfilling last month's hours therefore ages a task rather than refreshing
 * it, which is the honest reading: the work is still a month old.
 */
function activityWindow(history: PctHistory[], sessions: Session[]): Map<string, { first: number; last: number }> {
  const out = new Map<string, { first: number; last: number }>();
  const note = (id: string, t: number) => {
    if (!Number.isFinite(t)) return;
    const cur = out.get(id);
    if (!cur) out.set(id, { first: t, last: t });
    else {
      if (t < cur.first) cur.first = t;
      if (t > cur.last) cur.last = t;
    }
  };
  for (const h of history) if (h.pct > 0) note(h.node_id, fromIso(h.changed_at).getTime());
  for (const s of creditedSessions(sessions)) if (s.node_id) note(s.node_id, fromIso(s.started_at).getTime());
  return out;
}

/**
 * Open work that wants a decision, with each row's age measured against how
 * long comparable finished tasks actually took rather than against a number
 * someone picked. Only flagged rows come back; a quiet board returns nothing.
 *
 * This works the same whether time arrives from the countdown or is typed in
 * afterwards: every signal it reads is a logged session or a percent change.
 */
export function agingWip(
  nodes: DbNode[],
  history: PctHistory[],
  sessions: Session[],
  statusHistory: StatusHistory[] = [],
  now = new Date(),
): AgingRow[] {
  const nowMs = now.getTime();
  const kids = childrenOf(nodes);
  const leaves = nodes.filter((n) => (kids.get(n.id) ?? []).length === 0);
  const subj = subjectIndex(nodes);
  const hours = hoursByNodeInclusive(nodes, sessions);
  const window = activityWindow(history, sessions);
  const done = completionTimes(history);

  // How long finished tasks took, per project and pooled, as a p85 in days.
  const spans = new Map<string, number[]>();
  const pooled: number[] = [];
  for (const n of leaves) {
    if (n.pct_complete < 100) continue;
    const w = window.get(n.id);
    const end = done.get(n.id);
    if (!w || end === undefined) continue;
    const days = (end - w.first) / DAY_MS;
    if (!(days >= 0)) continue;
    const sid = subj.get(n.id)?.id;
    if (sid) spans.set(sid, [...(spans.get(sid) ?? []), days]);
    pooled.push(days);
  }
  const pooledP85 = pooled.length >= MIN_SUPPORT ? quantile(pooled, 0.85) : null;

  // Latest time each node was put into (or taken out of) a status.
  const blockedSince = new Map<string, number>();
  for (const h of [...statusHistory].sort((a, b) => a.changed_at.localeCompare(b.changed_at))) {
    const t = fromIso(h.changed_at).getTime();
    if (!Number.isFinite(t)) continue;
    if (h.status === "blocked") blockedSince.set(h.node_id, t);
    else blockedSince.delete(h.node_id);
  }

  const rows: AgingRow[] = [];
  for (const n of leaves) {
    if (n.pct_complete >= 100) continue;
    const subject = subj.get(n.id);
    if (!subject) continue;
    const w = window.get(n.id);
    const startedAt = w ? new Date(w.first) : null;
    const lastActivityAt = w ? new Date(w.last) : null;
    const ageDays = w ? (nowMs - w.first) / DAY_MS : null;
    const idleDays = w ? (nowMs - w.last) / DAY_MS : null;

    const own = spans.get(subject.id) ?? [];
    const typicalDays = own.length >= MIN_SUPPORT ? quantile(own, 0.85) : pooledP85;
    const typicalFrom = typicalDays === null ? null : own.length >= MIN_SUPPORT ? "project" : "all";

    const deadline = n.deadline ? fromIso(n.deadline) : null;
    const daysToDeadline = deadline && Number.isFinite(deadline.getTime()) ? (deadline.getTime() - nowMs) / DAY_MS : null;
    const plannedStart = n.planned_start ? fromIso(n.planned_start) : null;
    const blockedAt = n.status === "blocked" ? blockedSince.get(n.id) ?? null : null;

    const flags: AgingFlag[] = [];
    if (daysToDeadline !== null && daysToDeadline < 0) flags.push("late");
    if (n.status === "blocked") flags.push("blocked");
    if (ageDays !== null && typicalDays !== null && ageDays > typicalDays && (idleDays ?? 0) >= ACTIVE_DAYS) flags.push("overrun");
    if (idleDays !== null && idleDays >= IDLE_DAYS) flags.push("idle");
    if (n.pct_complete === 0 && !w && plannedStart && Number.isFinite(plannedStart.getTime()) && plannedStart.getTime() < nowMs) {
      flags.push("not-started");
    }
    if (flags.length === 0) continue;
    flags.sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b));

    rows.push({
      id: n.id,
      name: n.name,
      subjectId: subject.id,
      subjectName: subject.name,
      color: subject.color,
      pct: n.pct_complete,
      hoursLogged: hours.get(n.id) ?? 0,
      startedAt,
      lastActivityAt,
      ageDays,
      idleDays,
      typicalDays,
      typicalFrom,
      blockedSince: blockedAt === null ? null : new Date(blockedAt),
      blockedDays: blockedAt === null ? null : (nowMs - blockedAt) / DAY_MS,
      deadline: deadline && Number.isFinite(deadline.getTime()) ? deadline : null,
      daysToDeadline,
      plannedStart: plannedStart && Number.isFinite(plannedStart.getTime()) ? plannedStart : null,
      flags,
    });
  }

  return rows.sort((a, b) => {
    const d = FLAG_ORDER.indexOf(a.flags[0]) - FLAG_ORDER.indexOf(b.flags[0]);
    if (d !== 0) return d;
    return (b.idleDays ?? 0) - (a.idleDays ?? 0);
  });
}

/* ---------------------------------------------------- estimate bias */

export interface BiasRow {
  /** null on the pooled row */
  subjectId: string | null;
  name: string;
  color: string | null;
  /** finished tasks that had both an estimate and logged hours */
  samples: number;
  /** hours actually logged ÷ hours estimated; null when nothing to measure */
  ratio: number | null;
  estHours: number;
  actualHours: number;
  /** true when the ratio was borrowed from the pooled row for want of samples */
  fallback: boolean;
  confidence: VelocityConfidence;
}

/**
 * How far estimates land from reality, as a ratio: 1.8 means a task that was
 * called four hours took seven. Ratios are averaged in log space and reported
 * as a median, because overshooting by 2x and undershooting by 2x should
 * cancel out rather than average to 1.25.
 *
 * Only finished tasks count — an unfinished one has not spent all its hours
 * yet, so including it would drag every ratio down towards zero. A project
 * with fewer than MIN_SUPPORT finished tasks borrows the pooled ratio instead
 * of publishing a number that rests on two data points.
 */
export function estimateBias(nodes: DbNode[], sessions: Session[]): BiasRow[] {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const kids = childrenOf(nodes);
  const subj = subjectIndex(nodes);
  const hours = hoursByNodeInclusive(nodes, sessions);

  interface Acc { logs: number[]; est: number; actual: number }
  const per = new Map<string, Acc>();
  const all: Acc = { logs: [], est: 0, actual: 0 };

  for (const n of nodes) {
    if ((kids.get(n.id) ?? []).length > 0) continue;
    if (n.pct_complete < 100) continue;
    const subject = subj.get(n.id);
    if (!subject) continue;
    const f = hoursPerUnit(subject);
    if (f == null || n.est_effort == null) continue;
    const est = n.est_effort * f;
    const actual = hours.get(n.id) ?? 0;
    if (!(est > 0) || !(actual > 0)) continue;
    const acc = per.get(subject.id) ?? { logs: [], est: 0, actual: 0 };
    acc.logs.push(Math.log(actual / est));
    acc.est += est;
    acc.actual += actual;
    per.set(subject.id, acc);
    all.logs.push(Math.log(actual / est));
    all.est += est;
    all.actual += actual;
  }

  const ratioOf = (acc: Acc): number | null => {
    const m = median(acc.logs);
    return m === null ? null : Math.exp(m);
  };
  const confidenceOf = (n: number): VelocityConfidence => (n === 0 ? "none" : n < 3 ? "thin" : n < MIN_SUPPORT ? "fair" : "good");

  const pooledRatio = ratioOf(all);
  const rows: BiasRow[] = [
    {
      subjectId: null,
      name: "All projects",
      color: null,
      samples: all.logs.length,
      ratio: pooledRatio,
      estHours: all.est,
      actualHours: all.actual,
      fallback: false,
      confidence: confidenceOf(all.logs.length),
    },
  ];
  for (const s of subjects) {
    const acc = per.get(s.id);
    if (!acc) continue;
    const enough = acc.logs.length >= MIN_SUPPORT;
    rows.push({
      subjectId: s.id,
      name: s.name,
      color: s.color,
      samples: acc.logs.length,
      ratio: enough ? ratioOf(acc) : pooledRatio,
      estHours: acc.est,
      actualHours: acc.actual,
      fallback: !enough,
      confidence: confidenceOf(acc.logs.length),
    });
  }
  return rows;
}

/* ----------------------------------------------------------- rework */

export interface ReworkRow {
  /** null on the pooled row */
  subjectId: string | null;
  name: string;
  color: string | null;
  /** percent changes of any size */
  moves: number;
  /** those that went backwards */
  backwards: number;
  /** total percentage points given back */
  pointsLost: number;
  /** distinct tasks that went backwards at least once */
  tasks: number;
  /** backwards ÷ moves, 0 when nothing moved */
  rate: number;
}

const MOVE_EPSILON = 0.05;

/**
 * How often progress is taken back. A percent that drops means work was redone,
 * marked done too early, or re-scoped — worth separating from raw pace, which
 * only ever shows the net.
 */
export function reworkRate(nodes: DbNode[], history: PctHistory[]): ReworkRow[] {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const subj = subjectIndex(nodes);
  const byNode = new Map<string, PctHistory[]>();
  for (const h of history) byNode.set(h.node_id, [...(byNode.get(h.node_id) ?? []), h]);

  interface Acc { moves: number; backwards: number; pointsLost: number; tasks: Set<string> }
  const blank = (): Acc => ({ moves: 0, backwards: 0, pointsLost: 0, tasks: new Set() });
  const per = new Map<string, Acc>();
  const all = blank();

  for (const [nodeId, rows] of byNode) {
    const subject = subj.get(nodeId);
    if (!subject) continue;
    const sorted = [...rows].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
    const acc = per.get(subject.id) ?? blank();
    // Every node starts at zero, so the first recorded percent is itself a move.
    for (let i = 0; i < sorted.length; i++) {
      const delta = sorted[i].pct - (i === 0 ? 0 : sorted[i - 1].pct);
      if (Math.abs(delta) <= MOVE_EPSILON) continue;
      acc.moves++;
      all.moves++;
      if (delta < 0) {
        acc.backwards++;
        all.backwards++;
        acc.pointsLost += -delta;
        all.pointsLost += -delta;
        acc.tasks.add(nodeId);
        all.tasks.add(nodeId);
      }
    }
    per.set(subject.id, acc);
  }

  const toRow = (subjectId: string | null, name: string, color: string | null, a: Acc): ReworkRow => ({
    subjectId,
    name,
    color,
    moves: a.moves,
    backwards: a.backwards,
    pointsLost: a.pointsLost,
    tasks: a.tasks.size,
    rate: a.moves ? a.backwards / a.moves : 0,
  });

  const rows = [toRow(null, "All projects", null, all)];
  for (const s of subjects) {
    const acc = per.get(s.id);
    if (acc && acc.moves > 0) rows.push(toRow(s.id, s.name, s.color, acc));
  }
  return rows;
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
