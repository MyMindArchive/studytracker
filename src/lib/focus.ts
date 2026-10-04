import type { DbNode } from "../types";
import { childrenOf, hoursPerUnit, type NodeRollup } from "./rollup";
import { daysUntil } from "./treeSort";

/**
 * The Focus list: a flat view of what you said matters, without the tree.
 *
 * A node is "marked" when it carries its own priority or its own deadline.
 * The list shows the deepest marked node that is still open: if Chapter 1 is
 * Urgent and Part A inside it is Urgent too, only Part A is listed, because
 * it is the more precise answer to "what should I work on". When Part A is
 * finished Chapter 1 comes back, since whatever is left in it is now the most
 * precise thing that is marked.
 */
export type FocusSort = "combined" | "priority" | "due";

export const FOCUS_SORT_OPTIONS: { id: FocusSort; label: string; hint: string }[] = [
  { id: "combined", label: "Combined", hint: "Half priority, half how much work is left per day until it is due" },
  { id: "priority", label: "Priority", hint: "Highest priority first, then the earliest deadline" },
  { id: "due", label: "Deadline", hint: "Earliest deadline first, then the highest priority" },
];

export function isFocusSort(v: unknown): v is FocusSort {
  return v === "combined" || v === "priority" || v === "due";
}

/** Days out at which a deadline without an estimate scores 50 (see deadlineScore). */
const HALF_LIFE_DAYS = 7;

export interface FocusItem {
  node: DbNode;
  /** top-level project */
  subject: DbNode;
  /** ancestors from the project down to the direct parent; empty for a project */
  ancestors: DbNode[];
  /** own priority rank, else the nearest ancestor's */
  priority: number | null;
  priorityInherited: boolean;
  /** own deadline, else the nearest ancestor's */
  deadline: string | null;
  deadlineInherited: boolean;
  /** days until the deadline, negative when overdue */
  days: number | null;
  pct: number;
  blocked: boolean;
  /** remaining effort could not be turned into hours, so the deadline score fell back to days */
  noEstimate: boolean;
  /** remaining hours per day until due, when it could be computed */
  hoursPerDay: number | null;
  /** 0..100 */
  priorityScore: number;
  /** 0..100 */
  deadlineScore: number;
  /** 0..100, half of each */
  score: number;
}

export interface FocusContext {
  nodes: DbNode[];
  rollup: Map<string, NodeRollup>;
  dailyTargetHours: number;
  today: Date;
}

/** Priority rank (10..50) onto 0..100: Low 20, Medium 40, High 60, Urgent 80, Emergency 100. */
export function priorityScore(rank: number | null): number {
  if (rank === null) return 0;
  return Math.max(0, Math.min(100, rank * 2));
}

/**
 * Deadline onto 0..100. With an estimate it is the remaining hours per day
 * until due measured against the daily target: needing your whole daily
 * target every day scores 100. Without one it falls back to the calendar,
 * 100 today and 50 a week out. Anything overdue is 100 either way, because a
 * small task past its date is not less late than a big one.
 */
export function deadlineScore(days: number | null, remainingHours: number | null, dailyTargetHours: number): { score: number; hoursPerDay: number | null } {
  if (days === null) return { score: 0, hoursPerDay: null };
  if (days < 0) return { score: 100, hoursPerDay: remainingHours !== null ? remainingHours : null };
  if (remainingHours !== null && remainingHours > 0) {
    const perDay = remainingHours / (days + 1);
    const target = dailyTargetHours > 0 ? dailyTargetHours : 4;
    return { score: Math.min(100, (perDay / target) * 100), hoursPerDay: perDay };
  }
  return { score: (100 * HALF_LIFE_DAYS) / (HALF_LIFE_DAYS + days), hoursPerDay: null };
}

export function focusItems(ctx: FocusContext): FocusItem[] {
  const kids = childrenOf(ctx.nodes);
  const done = (id: string) => (ctx.rollup.get(id)?.pct ?? 0) >= 100;
  const marked = (n: DbNode) => n.priority !== null || n.deadline !== null;
  const out: FocusItem[] = [];

  /** Returns true when this subtree holds an open marked node (so the parent is covered). */
  const visit = (n: DbNode, ancestors: DbNode[]): boolean => {
    const path = [...ancestors, n];
    let covered = false;
    for (const c of kids.get(n.id) ?? []) if (visit(c, path)) covered = true;
    const open = !done(n.id);
    if (marked(n) && open && !covered) out.push(build(n, ancestors));
    return covered || (marked(n) && open);
  };

  const build = (n: DbNode, ancestors: DbNode[]): FocusItem => {
    const subject = ancestors[0] ?? n;
    const fromAbove = <T,>(pick: (x: DbNode) => T | null): { value: T | null; inherited: boolean } => {
      const own = pick(n);
      if (own !== null) return { value: own, inherited: false };
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const v = pick(ancestors[i]);
        if (v !== null) return { value: v, inherited: true };
      }
      return { value: null, inherited: false };
    };
    const pr = fromAbove((x) => x.priority);
    const dl = fromAbove((x) => x.deadline);
    const r = ctx.rollup.get(n.id);
    const days = dl.value ? daysUntil(dl.value, ctx.today) : null;
    const factor = hoursPerUnit(subject);
    const remainingUnits = r ? Math.max(0, r.estTotal - r.doneTotal) : 0;
    const remainingHours = r && r.estTotal > 0 && factor !== null ? remainingUnits * factor : null;
    const d = deadlineScore(days, remainingHours, ctx.dailyTargetHours);
    const p = priorityScore(pr.value);
    return {
      node: n,
      subject,
      ancestors,
      priority: pr.value,
      priorityInherited: pr.inherited,
      deadline: dl.value,
      deadlineInherited: dl.inherited,
      days,
      pct: r?.pct ?? 0,
      blocked: n.status === "blocked",
      noEstimate: days !== null && remainingHours === null,
      hoursPerDay: d.hoursPerDay,
      priorityScore: p,
      deadlineScore: d.score,
      score: (p + d.score) / 2,
    };
  };

  for (const root of kids.get(null) ?? []) visit(root, []);
  return out;
}

export function sortFocus(items: FocusItem[], key: FocusSort): FocusItem[] {
  const byDue = (a: FocusItem, b: FocusItem) => {
    if (a.deadline === b.deadline) return 0;
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  };
  const byPriority = (a: FocusItem, b: FocusItem) => {
    if (a.priority === b.priority) return 0;
    if (a.priority === null) return 1;
    if (b.priority === null) return -1;
    return b.priority - a.priority;
  };
  const byName = (a: FocusItem, b: FocusItem) => a.node.name.localeCompare(b.node.name, undefined, { sensitivity: "base", numeric: true });
  const cmp = (a: FocusItem, b: FocusItem): number => {
    // Blocked work cannot be picked up, so it waits at the bottom whatever the order.
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    switch (key) {
      case "priority":
        return byPriority(a, b) || byDue(a, b) || byName(a, b);
      case "due":
        return byDue(a, b) || byPriority(a, b) || byName(a, b);
      default:
        return b.score - a.score || byDue(a, b) || byName(a, b);
    }
  };
  return [...items].sort(cmp);
}

/** The first few things to work on next, in combined order, leaving blocked work out. */
export function upNext(ctx: FocusContext, limit = 5): FocusItem[] {
  return sortFocus(focusItems(ctx), "combined")
    .filter((i) => !i.blocked)
    .slice(0, limit);
}
