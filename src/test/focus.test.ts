import { describe, expect, it } from "vitest";
import type { DbNode } from "../types";
import { computeRollup } from "../lib/rollup";
import { deadlineScore, focusItems, priorityScore, sortFocus, upNext } from "../lib/focus";

const TODAY = new Date(2026, 9, 4); // 2026-10-04 local

function node(p: Partial<DbNode> & { id: string; name: string }): DbNode {
  return {
    parent_id: null,
    depth: 0,
    sort_order: 0,
    est_effort: null,
    pct_complete: 0,
    deadline: null,
    planned_start: null,
    status: null,
    priority: null,
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

const ctxOf = (nodes: DbNode[], dailyTargetHours = 4) => ({ nodes, rollup: computeRollup(nodes), dailyTargetHours, today: TODAY });
const ids = (nodes: DbNode[]) => focusItems(ctxOf(nodes)).map((i) => i.node.id);

describe("which nodes the Focus list shows", () => {
  const calc = node({ id: "calc", name: "Calculus" });
  const ch1 = node({ id: "ch1", name: "Chapter 1", parent_id: "calc", depth: 1, priority: 40 });
  const partA = node({ id: "a", name: "Part A", parent_id: "ch1", depth: 2, priority: 40, est_effort: 2 });
  const partB = node({ id: "b", name: "Part B", parent_id: "ch1", depth: 2, sort_order: 1, est_effort: 2 });

  it("shows only the deepest marked node", () => {
    expect(ids([calc, ch1, partA, partB])).toEqual(["a"]);
  });

  it("brings the parent back once the deeper one is finished", () => {
    expect(ids([calc, ch1, { ...partA, pct_complete: 100 }, partB])).toEqual(["ch1"]);
  });

  it("drops everything once the marked group is finished", () => {
    expect(ids([calc, ch1, { ...partA, pct_complete: 100 }, { ...partB, pct_complete: 100 }])).toEqual([]);
  });

  it("counts a deadline alone as marked", () => {
    expect(ids([calc, { ...ch1, priority: null }, { ...partA, priority: null }, { ...partB, deadline: "2026-10-10" }])).toEqual(["b"]);
  });

  it("shows nothing when nothing is marked", () => {
    expect(ids([calc, { ...ch1, priority: null }, { ...partA, priority: null }, partB])).toEqual([]);
  });

  it("inherits priority and deadline from above and names the project", () => {
    const items = focusItems(ctxOf([calc, { ...ch1, deadline: "2026-10-07" }, { ...partA, priority: null, deadline: null, status: "blocked" }, { ...partB, deadline: "2026-10-09" }]));
    const b = items.find((i) => i.node.id === "b")!;
    expect(b.priority).toBe(40);
    expect(b.priorityInherited).toBe(true);
    expect(b.deadline).toBe("2026-10-09");
    expect(b.deadlineInherited).toBe(false);
    expect(b.subject.id).toBe("calc");
    expect(b.ancestors.map((a) => a.id)).toEqual(["calc", "ch1"]);
  });
});

describe("scores", () => {
  it("maps priority levels onto 20..100", () => {
    expect([10, 20, 30, 40, 50].map(priorityScore)).toEqual([20, 40, 60, 80, 100]);
    expect(priorityScore(null)).toBe(0);
  });

  it("measures hours per day against the daily target", () => {
    // 8h left over 4 days (today included) = 2h/day against 4h = 50
    expect(deadlineScore(3, 8, 4).score).toBe(50);
    expect(deadlineScore(0, 40, 4).score).toBe(100);
  });

  it("falls back to the calendar without an estimate", () => {
    expect(deadlineScore(0, null, 4).score).toBe(100);
    expect(deadlineScore(7, null, 4).score).toBe(50);
  });

  it("scores anything overdue as 100 and no deadline as 0", () => {
    expect(deadlineScore(-1, 0.5, 4).score).toBe(100);
    expect(deadlineScore(null, 10, 4).score).toBe(0);
  });

  it("flags a deadline that has no estimate to work from", () => {
    const nodes = [node({ id: "s", name: "S" }), node({ id: "t", name: "T", parent_id: "s", depth: 1, deadline: "2026-10-11" })];
    const [t] = focusItems(ctxOf(nodes));
    expect(t.noEstimate).toBe(true);
    expect(t.deadlineScore).toBe(50);
  });

  it("converts units to hours through the project", () => {
    const nodes = [
      node({ id: "s", name: "Reading", unit: "pages", hours_per_unit: 0.1 }),
      node({ id: "t", name: "Book", parent_id: "s", depth: 1, est_effort: 80, deadline: "2026-10-05" }),
    ];
    const [t] = focusItems(ctxOf(nodes));
    // 80 pages × 0.1h = 8h over 2 days = 4h/day = the whole target
    expect(t.hoursPerDay).toBe(4);
    expect(t.deadlineScore).toBe(100);
  });
});

describe("ordering", () => {
  const s = node({ id: "s", name: "S" });
  const urgentFar = node({ id: "uf", name: "Urgent far", parent_id: "s", depth: 1, priority: 40, deadline: "2026-11-30" });
  const lowSoon = node({ id: "ls", name: "Low soon", parent_id: "s", depth: 1, sort_order: 1, priority: 10, deadline: "2026-10-04" });
  const highMid = node({ id: "hm", name: "High mid", parent_id: "s", depth: 1, sort_order: 2, priority: 30, deadline: "2026-10-08" });
  const blocked = node({ id: "bl", name: "Blocked", parent_id: "s", depth: 1, sort_order: 3, priority: 50, deadline: "2026-10-04", status: "blocked" });
  const items = focusItems(ctxOf([s, urgentFar, lowSoon, highMid, blocked]));

  it("sorts by priority, then deadline, blocked last", () => {
    expect(sortFocus(items, "priority").map((i) => i.node.id)).toEqual(["uf", "hm", "ls", "bl"]);
  });

  it("sorts by deadline, blocked last", () => {
    expect(sortFocus(items, "due").map((i) => i.node.id)).toEqual(["ls", "hm", "uf", "bl"]);
  });

  it("weighs both halves in the combined order", () => {
    // ls: (20 + 100)/2 = 60 · hm: (60 + 50·7/11… ≈ 63.6)/2 ≈ 61.8 · uf: (80 + ≈11.5)/2 ≈ 45.8
    expect(sortFocus(items, "combined").map((i) => i.node.id)).toEqual(["hm", "ls", "uf", "bl"]);
  });

  it("leaves blocked work out of Up next", () => {
    expect(upNext(ctxOf([s, urgentFar, lowSoon, highMid, blocked]), 2).map((i) => i.node.id)).toEqual(["hm", "ls"]);
  });
});
