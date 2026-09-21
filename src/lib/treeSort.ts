import type { DbNode } from "../types";
import type { NodeRollup } from "./rollup";
import { differenceInCalendarDays, parseISO, startOfDay } from "date-fns";

/**
 * Sort orders for the tree. Every key except "manual" is applied to each
 * sibling group independently, so the hierarchy is kept and every subtree
 * comes out ordered. "manual" is the stored drag-and-drop order.
 */
export type TreeSortKey = "manual" | "due" | "priority" | "urgency" | "progress" | "remaining" | "name";

export const TREE_SORT_OPTIONS: { id: TreeSortKey; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Your own order: drag rows to reorder or nest them" },
  { id: "priority", label: "Priority", hint: "Highest priority you set first, then by deadline; no priority last" },
  { id: "urgency", label: "Urgency", hint: "Most remaining effort per day until due first — computed, not set by you" },
  { id: "due", label: "Due date", hint: "Earliest deadline first; no deadline, then finished work, last" },
  { id: "progress", label: "Progress", hint: "Least complete first" },
  { id: "remaining", label: "Remaining", hint: "Most remaining effort first" },
  { id: "name", label: "Name", hint: "Alphabetical" },
];

export const TREE_SORT_KEYS: TreeSortKey[] = TREE_SORT_OPTIONS.map((o) => o.id);

export function isTreeSortKey(v: unknown): v is TreeSortKey {
  return typeof v === "string" && (TREE_SORT_KEYS as string[]).includes(v);
}

/**
 * Effective deadline per node: its own, else the earliest among its
 * unfinished descendants (so a chapter with no date still sorts by its
 * open tasks). `inherited` marks nodes whose date came from below.
 */
export interface EffectiveDeadline {
  date: string;
  inherited: boolean;
}

export function effectiveDeadlines(kids: Map<string | null, DbNode[]>, isDone: (id: string) => boolean = () => false): Map<string, EffectiveDeadline> {
  const out = new Map<string, EffectiveDeadline>();
  const visit = (n: DbNode): string | null => {
    let earliest: string | null = null;
    for (const c of kids.get(n.id) ?? []) {
      const d = visit(c);
      if (d && (!earliest || d < earliest)) earliest = d;
    }
    if (n.deadline) {
      out.set(n.id, { date: n.deadline, inherited: false });
      return isDone(n.id) ? null : n.deadline;
    }
    if (earliest) out.set(n.id, { date: earliest, inherited: true });
    return isDone(n.id) ? null : earliest;
  };
  for (const root of kids.get(null) ?? []) visit(root);
  return out;
}

/**
 * Effective priority per node: its own, else the highest among its unfinished
 * descendants — the same shape as the deadline rule above, so a group inherits
 * the urgency of what is still open underneath it and finishing that task lets
 * the group settle back down. `inherited` marks the ones that came from below.
 */
export interface EffectivePriority {
  rank: number;
  inherited: boolean;
}

export function effectivePriorities(kids: Map<string | null, DbNode[]>, isDone: (id: string) => boolean = () => false): Map<string, EffectivePriority> {
  const out = new Map<string, EffectivePriority>();
  const visit = (n: DbNode): number | null => {
    let highest: number | null = null;
    for (const c of kids.get(n.id) ?? []) {
      const r = visit(c);
      if (r !== null && (highest === null || r > highest)) highest = r;
    }
    if (n.priority !== null) {
      out.set(n.id, { rank: n.priority, inherited: false });
      return isDone(n.id) ? null : n.priority;
    }
    if (highest !== null) out.set(n.id, { rank: highest, inherited: true });
    return isDone(n.id) ? null : highest;
  };
  for (const root of kids.get(null) ?? []) visit(root);
  return out;
}

export interface SortContext {
  rollup: Map<string, NodeRollup>;
  deadlines: Map<string, EffectiveDeadline>;
  priorities: Map<string, EffectivePriority>;
  today: Date;
}

/** Days from today until an ISO date (negative when overdue). */
export function daysUntil(isoDate: string, today: Date): number {
  return differenceInCalendarDays(parseISO(isoDate), startOfDay(today));
}

/**
 * Urgency score: remaining effort spread over the days left. Higher is more
 * urgent. Overdue work gets the full remaining effort per day; nodes with no
 * deadline or nothing left to do score 0.
 *
 * This is computed from effort and dates — it is not the priority you set by
 * hand, which is `nodes.priority` and its own sort key.
 */
export function urgencyScore(n: DbNode, ctx: SortContext): number {
  const r = ctx.rollup.get(n.id);
  const dl = ctx.deadlines.get(n.id);
  if (!r || !dl) return 0;
  const remaining = Math.max(0, r.estTotal - r.doneTotal);
  if (remaining <= 0) return 0;
  const days = Math.max(1, daysUntil(dl.date, ctx.today) + 1);
  return remaining / days;
}

/** Return the siblings in the requested order. Manual order is left untouched. */
export function sortSiblings(siblings: DbNode[], key: TreeSortKey, ctx: SortContext): DbNode[] {
  if (key === "manual") return siblings;
  const withIndex = siblings.map((n, i) => ({ n, i }));
  const pct = (n: DbNode) => ctx.rollup.get(n.id)?.pct ?? 0;
  const remaining = (n: DbNode) => {
    const r = ctx.rollup.get(n.id);
    return r ? Math.max(0, r.estTotal - r.doneTotal) : 0;
  };
  const due = (n: DbNode) => ctx.deadlines.get(n.id)?.date ?? null;
  const done = (n: DbNode) => pct(n) >= 100;
  const rank = (n: DbNode) => ctx.priorities.get(n.id)?.rank ?? null;
  /** Finished last, then earliest deadline, then no deadline. Reused by the priority tie-break. */
  const byDue = (a: DbNode, b: DbNode): number => {
    if (done(a) !== done(b)) return done(a) ? 1 : -1;
    const da = due(a),
      db = due(b);
    if (da === db) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  };
  const cmp = (a: DbNode, b: DbNode): number => {
    switch (key) {
      case "due":
        return byDue(a, b);
      case "priority": {
        // Five levels over a long list means ties are the normal case, so the
        // deadline breaks them: without that this sort would be five buckets
        // in whatever order they happened to be stored in.
        if (done(a) !== done(b)) return done(a) ? 1 : -1;
        const ra = rank(a),
          rb = rank(b);
        if (ra !== rb) {
          if (ra === null) return 1;
          if (rb === null) return -1;
          return rb - ra;
        }
        return byDue(a, b);
      }
      case "urgency":
        return urgencyScore(b, ctx) - urgencyScore(a, ctx);
      case "progress":
        return pct(a) - pct(b);
      case "remaining":
        return remaining(b) - remaining(a);
      case "name":
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      default:
        return 0;
    }
  };
  withIndex.sort((x, y) => cmp(x.n, y.n) || x.i - y.i);
  return withIndex.map((x) => x.n);
}
