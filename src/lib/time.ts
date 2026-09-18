import { startOfWeek, format, parseISO, startOfDay, startOfMonth, addWeeks, differenceInCalendarDays, isValid } from "date-fns";

export const WEEK_STARTS_ON = 1; // Monday

export function weekStart(d: Date): Date {
  return startOfWeek(d, { weekStartsOn: WEEK_STARTS_ON });
}

export function dayKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}
export function weekKey(d: Date): string {
  return format(weekStart(d), "yyyy-MM-dd");
}
export function monthKey(d: Date): string {
  return format(startOfMonth(d), "yyyy-MM");
}

export function bucketKey(d: Date, period: "day" | "week" | "month"): string {
  return period === "day" ? dayKey(d) : period === "week" ? weekKey(d) : monthKey(d);
}

export function iso(d: Date): string {
  return d.toISOString();
}
export function fromIso(s: string): Date {
  return parseISO(s);
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function secondsToHours(s: number): number {
  return s / 3600;
}

export function fmtHours(h: number, digits = 1): string {
  if (!Number.isFinite(h)) return "–";
  return `${h.toFixed(digits)}h`;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Consecutive local days ending today (or yesterday) with at least one entry. */
export function streak(days: Set<string>, today = new Date()): number {
  let count = 0;
  let cursor = startOfDay(today);
  if (!days.has(dayKey(cursor))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
    if (!days.has(dayKey(cursor))) return 0;
  }
  while (days.has(dayKey(cursor))) {
    count++;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return count;
}

export function weeksBetween(a: Date, b: Date): number {
  return Math.round(differenceInCalendarDays(b, a) / 7);
}

export function listWeekStarts(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cur = weekStart(from);
  const end = weekStart(to);
  while (cur.getTime() <= end.getTime()) {
    out.push(cur);
    cur = addWeeks(cur, 1);
  }
  return out;
}

export type DueTone = "overdue" | "today" | "soon" | "normal";

/**
 * Short relative label for a deadline: "today", "tomorrow", "in 3d",
 * "2d overdue", or the calendar date once it is more than two weeks out.
 */
export function relativeDue(isoDate: string, today = new Date()): { label: string; tone: DueTone; days: number } {
  const d = parseISO(isoDate);
  if (!isValid(d)) return { label: isoDate, tone: "normal", days: Number.NaN };
  const days = differenceInCalendarDays(d, startOfDay(today));
  if (days < 0) return { label: `${-days}d overdue`, tone: "overdue", days };
  if (days === 0) return { label: "today", tone: "today", days };
  if (days === 1) return { label: "tomorrow", tone: "soon", days };
  if (days <= 3) return { label: `in ${days}d`, tone: "soon", days };
  if (days <= 14) return { label: `in ${days}d`, tone: "normal", days };
  const sameYear = d.getFullYear() === today.getFullYear();
  return { label: format(d, sameYear ? "MMM d" : "MMM d, yyyy"), tone: "normal", days };
}
