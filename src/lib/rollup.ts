import type { DbNode, RollupMode } from "../types";
import { DEFAULT_SETTINGS } from "../types";

export type Status = "Not started" | "In progress" | "Done";

export interface NodeRollup {
  /** 0..100 */
  pct: number;
  /** sum of descendant leaf est_effort (subject unit) */
  estTotal: number;
  /** completed effort implied by pct: estTotal * pct / 100 */
  doneTotal: number;
  isLeaf: boolean;
  status: Status;
  leafCount: number;
  /** rule this node uses to combine its children (inherited when not set on the node) */
  mode: RollupMode;
}

export function statusFor(pct: number): Status {
  if (pct >= 100) return "Done";
  if (pct <= 0) return "Not started";
  return "In progress";
}

export function childrenOf(nodes: DbNode[]): Map<string | null, DbNode[]> {
  const m = new Map<string | null, DbNode[]>();
  for (const n of nodes) {
    const arr = m.get(n.parent_id) ?? [];
    arr.push(n);
    m.set(n.parent_id, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  return m;
}

/** Sibling weight as stored, defaulting to 1 and never negative. */
export function weightOf(n: DbNode): number {
  const w = Number(n.weight);
  if (n.weight === null || n.weight === undefined || !Number.isFinite(w)) return 1;
  return Math.max(0, w);
}

/**
 * Roll-up. Each parent combines its direct children by its effective mode
 * (own `rollup_mode`, else the nearest ancestor's, else `defaultMode`):
 *
 *  equal   parent pct = mean of child pcts
 *  weight  parent pct = Σ(child.weight × child pct) / Σ child.weight
 *  effort  parent pct = Σ(leaf est × leaf pct) / Σ leaf est over all descendant
 *          leaves; leaves without an estimate carry no weight, and if no
 *          descendant has an estimate the mean of leaf pcts is used instead.
 *
 * estTotal is always the plain sum of descendant leaf estimates so hours
 * statistics stay comparable across modes; doneTotal follows the displayed pct.
 */
export function computeRollup(nodes: DbNode[], defaultMode: RollupMode = DEFAULT_SETTINGS.rollup_mode): Map<string, NodeRollup> {
  const kids = childrenOf(nodes);
  const out = new Map<string, NodeRollup>();

  interface Acc {
    pct: number;
    est: number;
    effortDone: number;
    leafPctSum: number;
    leafCount: number;
  }

  const visit = (n: DbNode, inherited: RollupMode): Acc => {
    const mode = n.rollup_mode ?? inherited;
    const ch = kids.get(n.id) ?? [];
    if (ch.length === 0) {
      const est = n.est_effort ?? 0;
      const pct = clampPct(n.pct_complete);
      const done = (est * pct) / 100;
      out.set(n.id, { pct, estTotal: est, doneTotal: done, isLeaf: true, status: statusFor(pct), leafCount: 1, mode });
      return { pct, est, effortDone: done, leafPctSum: pct, leafCount: 1 };
    }
    let est = 0,
      effortDone = 0,
      leafPctSum = 0,
      leafCount = 0,
      wSum = 0,
      wPct = 0;
    const childPcts: number[] = [];
    for (const c of ch) {
      const r = visit(c, mode);
      est += r.est;
      effortDone += r.effortDone;
      leafPctSum += r.leafPctSum;
      leafCount += r.leafCount;
      childPcts.push(r.pct);
      const w = weightOf(c);
      wSum += w;
      wPct += w * r.pct;
    }
    const meanOfChildren = childPcts.reduce((a, b) => a + b, 0) / childPcts.length;
    let pct: number;
    if (mode === "effort") pct = est > 0 ? (effortDone / est) * 100 : leafCount > 0 ? leafPctSum / leafCount : 0;
    else if (mode === "weight") pct = wSum > 0 ? wPct / wSum : meanOfChildren;
    else pct = meanOfChildren;
    pct = clampPct(pct);
    out.set(n.id, { pct, estTotal: est, doneTotal: (est * pct) / 100, isLeaf: false, status: statusFor(pct), leafCount, mode });
    return { pct, est, effortDone, leafPctSum, leafCount };
  };

  for (const root of kids.get(null) ?? []) visit(root, defaultMode);
  return out;
}

export const ROLLUP_LABEL: Record<RollupMode, string> = {
  equal: "Equal share",
  weight: "Custom weights",
  effort: "By estimated effort",
};

export const ROLLUP_HELP: Record<RollupMode, string> = {
  equal: "Every child task counts the same; a group counts once no matter how many tasks it holds.",
  weight: "Each child counts by its weight (default 1). Give a big task weight 2 to count it twice.",
  effort: "Leaf tasks count by estimated effort, so 10 h at 50 % outweighs 1 h at 100 %.",
};

export function clampPct(p: number): number {
  if (Number.isNaN(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

/** Map every node id to its top-level subject. */
export function subjectIndex(nodes: DbNode[]): Map<string, DbNode> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, DbNode>();
  for (const n of nodes) {
    let cur: DbNode | undefined = n;
    while (cur && cur.parent_id) cur = byId.get(cur.parent_id);
    if (cur) out.set(n.id, cur);
  }
  return out;
}

export interface RootTotals {
  pct: number;
  /** estimated hours across subjects — only when every subject has hours_per_unit */
  estHours: number | null;
  remainingHours: number | null;
  subjectCount: number;
}

/**
 * Root totals. Overall pct is hours-weighted where conversions exist, else the
 * mean of subject percents (units differ, so effort cannot be summed).
 */
export function rootTotals(nodes: DbNode[], roll: Map<string, NodeRollup>): RootTotals {
  const subjects = nodes.filter((n) => n.parent_id === null);
  if (subjects.length === 0) return { pct: 0, estHours: null, remainingHours: null, subjectCount: 0 };
  const allConvertible = subjects.every((s) => hoursPerUnit(s) !== null);
  if (allConvertible) {
    let est = 0,
      done = 0;
    for (const s of subjects) {
      const r = roll.get(s.id)!;
      const f = hoursPerUnit(s)!;
      est += r.estTotal * f;
      done += r.doneTotal * f;
    }
    return {
      pct: est > 0 ? (done / est) * 100 : 0,
      estHours: est,
      remainingHours: Math.max(0, est - done),
      subjectCount: subjects.length,
    };
  }
  const mean = subjects.reduce((a, s) => a + (roll.get(s.id)?.pct ?? 0), 0) / subjects.length;
  return { pct: mean, estHours: null, remainingHours: null, subjectCount: subjects.length };
}

/** Conversion factor to hours: explicit hours_per_unit, or 1 when unit is hours. */
export function hoursPerUnit(subject: DbNode): number | null {
  if (subject.hours_per_unit != null && subject.hours_per_unit > 0) return subject.hours_per_unit;
  if ((subject.unit ?? "hours").toLowerCase() === "hours") return 1;
  return null;
}
