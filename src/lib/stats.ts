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

export interface VelocityRow {
  subjectId: string;
  name: string;
  color: string | null;
  currentPct: number;
  /** pct at the end of each week (oldest first) */
  weekly: { week: string; pct: number }[];
  /** average pct points per week over the trailing window */
  velocity: number;
  /** naive weeks remaining to 100 at current velocity; null if velocity <= 0 or done */
  forecastWeeks: number | null;
}

/** Rebuild leaf pct as of a timestamp using pct_history (0 if no history yet). */
export function pctAsOf(nodes: DbNode[], history: PctHistory[], at: Date): DbNode[] {
  const t = at.getTime();
  const latest = new Map<string, { t: number; pct: number }>();
  for (const h of history) {
    const ht = fromIso(h.changed_at).getTime();
    if (ht > t) continue;
    const cur = latest.get(h.node_id);
    if (!cur || ht >= cur.t) latest.set(h.node_id, { t: ht, pct: h.pct });
  }
  return nodes.map((n) => ({ ...n, pct_complete: latest.get(n.id)?.pct ?? 0 }));
}

export function velocity(nodes: DbNode[], history: PctHistory[], now = new Date(), weeks = 8, window = 4, mode?: RollupMode): VelocityRow[] {
  const subjects = nodes.filter((n) => n.parent_id === null);
  const current = computeRollup(nodes, mode);
  const weekEnds: Date[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    weekEnds.push(endOfWeek(addWeeks(now, -i), { weekStartsOn: WEEK_STARTS_ON }));
  }
  const snapshots = weekEnds.map((we) => {
    const at = we.getTime() > now.getTime() ? now : we;
    return { week: weekKey(we), roll: computeRollup(pctAsOf(nodes, history, at), mode) };
  });
  return subjects.map((s) => {
    const weekly = snapshots.map((sn) => ({ week: sn.week, pct: sn.roll.get(s.id)?.pct ?? 0 }));
    const deltas: number[] = [];
    for (let i = Math.max(1, weekly.length - window); i < weekly.length; i++) deltas.push(weekly[i].pct - weekly[i - 1].pct);
    const v = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const cur = current.get(s.id)?.pct ?? 0;
    const forecast = cur >= 100 ? 0 : v > 0 ? (100 - cur) / v : null;
    return { subjectId: s.id, name: s.name, color: s.color, currentPct: cur, weekly, velocity: v, forecastWeeks: forecast };
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
