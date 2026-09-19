import { describe, expect, it } from "vitest";
import type { DbNode } from "../types";
import { childrenOf, computeRollup } from "../lib/rollup";
import { effectiveDeadlines, priorityScore, sortSiblings } from "../lib/treeSort";
import { relativeDue } from "../lib/time";

const TODAY = new Date(2026, 8, 18); // 2026-09-18 local

function node(p: Partial<DbNode> & { id: string; name: string }): DbNode {
  return {
    parent_id: null,
    depth: p.parent_id ? 1 : 0,
    sort_order: 0,
    est_effort: null,
    pct_complete: 0,
    deadline: null,
    planned_start: null,
    status: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    weight: 1,
    rollup_mode: null,
    unit: p.parent_id ? null : "hours",
    hours_per_unit: null,
    weekly_target_hours: null,
    color: null,
    ...p,
  };
}

// Subject "Econ" with three chapters in manual order 2, 3, 1 (mirrors the screenshot)
const nodes: DbNode[] = [
  node({ id: "econ", name: "Economics" }),
  node({ id: "c2", name: "Chapter 2", parent_id: "econ", sort_order: 0, est_effort: 1, deadline: "2026-09-19" }),
  node({ id: "c3", name: "Chapter 3", parent_id: "econ", sort_order: 1, est_effort: 1, deadline: "2026-09-19" }),
  node({ id: "c1", name: "Chapter 1", parent_id: "econ", sort_order: 2, est_effort: 1 }),
  // c1 has no deadline of its own; its task does
  node({ id: "c1a", name: "Exercises", parent_id: "c1", depth: 2, sort_order: 0, est_effort: 1, pct_complete: 67, deadline: "2026-09-18" }),
  node({ id: "proj", name: "Project Study", sort_order: 1 }),
  node({ id: "adv", name: "Advance Econometric", sort_order: 2 }),
  node({ id: "adv1", name: "Chapter 1", parent_id: "adv", sort_order: 0, est_effort: 1 }),
];

const kids = childrenOf(nodes);
const rollup = computeRollup(nodes, "equal");
const deadlines = effectiveDeadlines(kids);
const ctx = { rollup, deadlines, today: TODAY };
const names = (arr: DbNode[]) => arr.map((n) => n.name);

describe("effectiveDeadlines", () => {
  it("uses the node's own deadline, else the earliest below it", () => {
    expect(deadlines.get("c2")).toEqual({ date: "2026-09-19", inherited: false });
    expect(deadlines.get("c1")).toEqual({ date: "2026-09-18", inherited: true });
    expect(deadlines.get("econ")).toEqual({ date: "2026-09-18", inherited: true });
    expect(deadlines.get("proj")).toBeUndefined();
  });

  it("does not lift a finished task's deadline to its parent, but keeps it on the task", () => {
    const withDone = nodes.map((n) => (n.id === "c1a" ? { ...n, pct_complete: 100 } : n));
    const k = childrenOf(withDone);
    const r = computeRollup(withDone, "equal");
    const d = effectiveDeadlines(k, (id) => (r.get(id)?.pct ?? 0) >= 100);
    expect(d.get("c1a")).toEqual({ date: "2026-09-18", inherited: false });
    expect(d.get("c1")).toBeUndefined();
    expect(d.get("econ")).toEqual({ date: "2026-09-19", inherited: true });
    // due sort puts finished chapters last
    const ctx2 = { rollup: r, deadlines: d, today: TODAY };
    expect(names(sortSiblings(k.get("econ")!, "due", ctx2))).toEqual(["Chapter 2", "Chapter 3", "Chapter 1"]);
  });
});

describe("sortSiblings", () => {
  const chapters = kids.get("econ")!;

  it("leaves manual order alone", () => {
    expect(names(sortSiblings(chapters, "manual", ctx))).toEqual(["Chapter 2", "Chapter 3", "Chapter 1"]);
  });

  it("orders a subtree by due date, inherited dates included, and keeps ties stable", () => {
    expect(names(sortSiblings(chapters, "due", ctx))).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("puts nodes without a deadline last", () => {
    const subjects = kids.get(null)!;
    expect(names(sortSiblings(subjects, "due", ctx))).toEqual(["Economics", "Project Study", "Advance Econometric"]);
  });

  it("sorts by least progress and by name", () => {
    expect(names(sortSiblings(chapters, "progress", ctx))).toEqual(["Chapter 2", "Chapter 3", "Chapter 1"]);
    expect(names(sortSiblings(chapters, "name", ctx))).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("ranks by priority: remaining effort per day until due", () => {
    // c2, c3: 1h left, due tomorrow -> 1/2 per day. c1: 0.33h left, due today -> 0.33/1.
    expect(priorityScore(nodes[1], ctx)).toBeCloseTo(0.5);
    expect(priorityScore(nodes[3], ctx)).toBeCloseTo(0.33);
    expect(names(sortSiblings(chapters, "priority", ctx))).toEqual(["Chapter 2", "Chapter 3", "Chapter 1"]);
    // nothing to do and no deadline -> 0
    expect(priorityScore(nodes[5], ctx)).toBe(0);
  });
});

describe("relativeDue", () => {
  it("formats relative to today", () => {
    expect(relativeDue("2026-09-18", TODAY)).toMatchObject({ label: "today", tone: "today" });
    expect(relativeDue("2026-09-19", TODAY)).toMatchObject({ label: "tomorrow", tone: "soon" });
    expect(relativeDue("2026-09-21", TODAY)).toMatchObject({ label: "in 3d", tone: "soon" });
    expect(relativeDue("2026-09-28", TODAY)).toMatchObject({ label: "in 10d", tone: "normal" });
    expect(relativeDue("2026-09-16", TODAY)).toMatchObject({ label: "2d overdue", tone: "overdue" });
    expect(relativeDue("2026-10-30", TODAY)).toMatchObject({ label: "Oct 30", tone: "normal" });
    expect(relativeDue("2027-01-05", TODAY)).toMatchObject({ label: "Jan 5, 2027", tone: "normal" });
    expect(relativeDue("nonsense", TODAY)).toMatchObject({ label: "nonsense", tone: "normal" });
  });
});
