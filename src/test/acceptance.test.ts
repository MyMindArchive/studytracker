import { describe, it, expect, beforeEach } from "vitest";
import { SqlJsDriver } from "../db/sqljs";
import { migrate, CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../db/migrations";
import { createNode, setPct, listPctHistory, insertSession, listSessions, listNodes, deleteNode, snapshotSubtree, restoreSubtree, moveNode, updateNode, duplicateNode, addChecklistItem, updateChecklistItem, deleteChecklistItem, syncChecklistPct, listChecklist, assignSessions, loadSettings, saveSetting, sanitizeSettings, setStatus, listStatusHistory } from "../db/repo";
import { computeRollup, rootTotals } from "../lib/rollup";
import { weeklySummary, thisWeekBySubject, hoursBySubjectForWeek, sessionStats, plannedVsActual, velocity, agingWip, estimateBias, reworkRate, quantile, IDLE_DAYS } from "../lib/stats";
import { uid } from "../lib/ids";
import { parseCsv, nodesCsv, parseNodesCsv } from "../lib/csv";
import { buildWorkbook } from "../lib/xlsx";
import * as XLSX from "xlsx";
import { weekKey } from "../lib/time";

let db: SqlJsDriver;
beforeEach(async () => {
  db = await SqlJsDriver.openMemory();
  await migrate(db);
});

describe("roll-up", () => {
  it("effort mode: subject with 10h@50% and 1h@100% shows 54.5%", async () => {
    const subj = await createNode(db, { parent_id: null, name: "Math", unit: "hours" });
    const a = await createNode(db, { parent_id: subj.id, name: "A", est_effort: 10 });
    const b = await createNode(db, { parent_id: subj.id, name: "B", est_effort: 1 });
    await setPct(db, a.id, 50);
    await setPct(db, b.id, 100);
    const roll = computeRollup(await listNodes(db), "effort");
    expect(roll.get(subj.id)!.pct).toBeCloseTo(54.5454, 3);
    expect(roll.get(subj.id)!.status).toBe("In progress");
    expect(roll.get(subj.id)!.mode).toBe("effort");
  });

  it("equal mode: every direct child counts once, whatever its effort or leaf count", async () => {
    const subj = await createNode(db, { parent_id: null, name: "Math" });
    const a = await createNode(db, { parent_id: subj.id, name: "A", est_effort: 10 });
    const group = await createNode(db, { parent_id: subj.id, name: "G" });
    const g1 = await createNode(db, { parent_id: group.id, name: "g1", est_effort: 1 });
    const g2 = await createNode(db, { parent_id: group.id, name: "g2", est_effort: 1 });
    await setPct(db, a.id, 50);
    await setPct(db, g1.id, 100);
    await setPct(db, g2.id, 0);
    const roll = computeRollup(await listNodes(db), "equal");
    expect(roll.get(group.id)!.pct).toBeCloseTo(50);
    // (50 + 50) / 2, not effort-weighted (which would be (5 + 1) / 12 = 50 % too, so nudge A)
    await setPct(db, a.id, 20);
    const roll2 = computeRollup(await listNodes(db), "equal");
    expect(roll2.get(subj.id)!.pct).toBeCloseTo(35);
    expect(computeRollup(await listNodes(db), "effort").get(subj.id)!.pct).toBeCloseTo((2 + 1) / 12 * 100, 3);
    // estTotal still sums leaf estimates, doneTotal follows the shown pct
    expect(roll2.get(subj.id)!.estTotal).toBe(12);
    expect(roll2.get(subj.id)!.doneTotal).toBeCloseTo(12 * 0.35);
  });

  it("weight mode: a child with weight 3 counts three times; weights default to 1", async () => {
    const subj = await createNode(db, { parent_id: null, name: "S", rollup_mode: "weight" });
    const a = await createNode(db, { parent_id: subj.id, name: "A" });
    const b = await createNode(db, { parent_id: subj.id, name: "B" });
    await setPct(db, a.id, 100);
    await setPct(db, b.id, 0);
    let roll = computeRollup(await listNodes(db), "equal");
    expect(roll.get(subj.id)!.mode).toBe("weight");
    expect(roll.get(subj.id)!.pct).toBeCloseTo(50);
    await updateNode(db, a.id, { weight: 3 });
    roll = computeRollup(await listNodes(db), "equal");
    expect(roll.get(subj.id)!.pct).toBeCloseTo(75);
    // weight 0 removes a child from the roll-up entirely
    await updateNode(db, b.id, { weight: 0 });
    roll = computeRollup(await listNodes(db), "equal");
    expect(roll.get(subj.id)!.pct).toBeCloseTo(100);
  });

  it("rollup_mode is inherited down the tree and survives duplicate / undo", async () => {
    const subj = await createNode(db, { parent_id: null, name: "S", rollup_mode: "effort" });
    const group = await createNode(db, { parent_id: subj.id, name: "G" });
    const x = await createNode(db, { parent_id: group.id, name: "x", est_effort: 9, weight: 2 });
    const y = await createNode(db, { parent_id: group.id, name: "y", est_effort: 1 });
    await setPct(db, x.id, 0);
    await setPct(db, y.id, 100);
    let roll = computeRollup(await listNodes(db), "equal");
    expect(roll.get(group.id)!.mode).toBe("effort");
    expect(roll.get(group.id)!.pct).toBeCloseTo(10);
    await updateNode(db, group.id, { rollup_mode: "weight" });
    roll = computeRollup(await listNodes(db), "equal");
    expect(roll.get(group.id)!.pct).toBeCloseTo((2 * 0 + 1 * 100) / 3, 3);
    const copyId = await duplicateNode(db, group.id);
    const nodes = await listNodes(db);
    expect(nodes.find((n) => n.id === copyId)!.rollup_mode).toBe("weight");
    expect(nodes.filter((n) => n.parent_id === copyId).find((n) => n.name === "x")!.weight).toBe(2);
    const snap = await snapshotSubtree(db, group.id);
    await deleteNode(db, group.id);
    await restoreSubtree(db, snap, {});
    expect((await listNodes(db)).find((n) => n.id === x.id)!.weight).toBe(2);
  });

  it("checklist items count equally and set the leaf percent through pct_history", async () => {
    const subj = await createNode(db, { parent_id: null, name: "Physics" });
    const ch = await createNode(db, { parent_id: subj.id, name: "Chapter 1", est_effort: 1 });
    for (const label of ["Theory", "Exercise", "Review"]) await addChecklistItem(db, ch.id, label);
    await syncChecklistPct(db, ch.id);
    let items = await listChecklist(db);
    expect(items.length).toBe(3);
    expect(items.every((i) => i.done === false)).toBe(true);
    await updateChecklistItem(db, items[0].id, { done: true });
    await updateChecklistItem(db, items[1].id, { done: true });
    await syncChecklistPct(db, ch.id);
    let nodes = await listNodes(db);
    expect(nodes.find((n) => n.id === ch.id)!.pct_complete).toBeCloseTo(66.667, 2);
    expect(computeRollup(nodes, "equal").get(subj.id)!.pct).toBeCloseTo(66.667, 2);
    expect((await listPctHistory(db, ch.id)).length).toBe(1);
    // deleting an item re-derives the percent; duplicate copies items unticked; undo restores them
    await deleteChecklistItem(db, items[2].id);
    await syncChecklistPct(db, ch.id);
    nodes = await listNodes(db);
    expect(nodes.find((n) => n.id === ch.id)!.pct_complete).toBe(100);
    const copy = await duplicateNode(db, ch.id);
    items = await listChecklist(db);
    expect(items.filter((i) => i.node_id === copy).map((i) => i.done)).toEqual([false, false]);
    const snap = await snapshotSubtree(db, ch.id);
    await deleteNode(db, ch.id);
    expect((await listChecklist(db)).filter((i) => i.node_id === ch.id).length).toBe(0);
    await restoreSubtree(db, snap, {});
    expect((await listChecklist(db)).filter((i) => i.node_id === ch.id).length).toBe(2);
  });

  it("schema v4 adds weight, rollup_mode, checklist_items, status and planned_start with sane defaults", async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    const s = await createNode(db, { parent_id: null, name: "S" });
    const [row] = await listNodes(db);
    expect(row.id).toBe(s.id);
    expect(row.weight).toBe(1);
    expect(row.rollup_mode).toBeNull();
    expect(row.status).toBeNull();
    expect(row.planned_start).toBeNull();
  });

  it("editing a leaf 20 -> 40 adds one pct_history row and changes the roll-up immediately", async () => {
    const subj = await createNode(db, { parent_id: null, name: "Physics" });
    const leaf = await createNode(db, { parent_id: subj.id, name: "L", est_effort: 5 });
    await setPct(db, leaf.id, 20);
    const before = (await listPctHistory(db, leaf.id)).length;
    await setPct(db, leaf.id, 40);
    const after = await listPctHistory(db, leaf.id);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].pct).toBe(40);
    const roll = computeRollup(await listNodes(db));
    expect(roll.get(subj.id)!.pct).toBeCloseTo(40);
  });

  it("derived status: 0 not started, 100 done", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 2 });
    let roll = computeRollup(await listNodes(db));
    expect(roll.get(l.id)!.status).toBe("Not started");
    await setPct(db, l.id, 100);
    roll = computeRollup(await listNodes(db));
    expect(roll.get(s.id)!.status).toBe("Done");
  });

  it("root totals only sum hours when every subject has a conversion", async () => {
    const a = await createNode(db, { parent_id: null, name: "A", unit: "hours" });
    const b = await createNode(db, { parent_id: null, name: "B", unit: "pages" });
    await createNode(db, { parent_id: a.id, name: "a1", est_effort: 10 });
    await createNode(db, { parent_id: b.id, name: "b1", est_effort: 100 });
    let nodes = await listNodes(db);
    let rt = rootTotals(nodes, computeRollup(nodes));
    expect(rt.estHours).toBeNull();
    await db.execute("UPDATE nodes SET hours_per_unit = 0.1 WHERE id = ?", [b.id]);
    nodes = await listNodes(db);
    rt = rootTotals(nodes, computeRollup(nodes));
    expect(rt.estHours).toBeCloseTo(20);
  });
});

describe("sessions", () => {
  it("aborting a 25m countdown at 12m with credit writes 720s aborted_credited", async () => {
    const start = new Date("2026-09-14T09:00:00Z");
    const end = new Date(start.getTime() + 720_000);
    await insertSession(db, {
      node_id: null,
      cycle_id: null,
      mode: "single",
      planned_seconds: 25 * 60,
      actual_seconds: 720,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      ended_reason: "aborted_credited",
      note: null,
    });
    const [s] = await listSessions(db);
    expect(s.actual_seconds).toBe(720);
    expect(s.ended_reason).toBe("aborted_credited");
  });

  it("a four-round cycle produces four rows sharing cycle_id and no break rows", async () => {
    const cycle = uid();
    for (let i = 0; i < 4; i++) {
      await insertSession(db, {
        node_id: null,
        cycle_id: cycle,
        mode: "cycle",
        planned_seconds: 1500,
        actual_seconds: 1500,
        started_at: new Date(Date.UTC(2026, 8, 14, 9 + i)).toISOString(),
        ended_at: new Date(Date.UTC(2026, 8, 14, 9 + i, 25)).toISOString(),
        ended_reason: "completed",
        note: null,
      });
    }
    const rows = await listSessions(db);
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((r) => r.cycle_id)).size).toBe(1);
    expect(rows.every((r) => r.mode === "cycle")).toBe(true);
  });

  it("deleting a node keeps its sessions as unassigned and undo restores them", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 1 });
    await setPct(db, l.id, 10);
    const sess = await insertSession(db, {
      node_id: l.id,
      cycle_id: null,
      mode: "single",
      planned_seconds: 60,
      actual_seconds: 60,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      ended_reason: "completed",
      note: null,
    });
    const snap = await snapshotSubtree(db, s.id);
    await deleteNode(db, s.id);
    expect((await listNodes(db)).length).toBe(0);
    expect((await listSessions(db))[0].node_id).toBeNull();
    await restoreSubtree(db, snap, { [sess.id]: l.id });
    expect((await listNodes(db)).length).toBe(2);
    expect((await listSessions(db))[0].node_id).toBe(l.id);
    expect((await listPctHistory(db, l.id)).length).toBe(1);
  });

  it("moveNode re-nests and fixes depth", async () => {
    const a = await createNode(db, { parent_id: null, name: "A" });
    const b = await createNode(db, { parent_id: null, name: "B" });
    const child = await createNode(db, { parent_id: a.id, name: "c" });
    const grand = await createNode(db, { parent_id: child.id, name: "g" });
    await moveNode(db, child.id, b.id, 0);
    const nodes = await listNodes(db);
    expect(nodes.find((n) => n.id === child.id)!.parent_id).toBe(b.id);
    expect(nodes.find((n) => n.id === grand.id)!.depth).toBe(2);
    await expect(moveNode(db, b.id, grand.id, 0)).rejects.toThrow();
  });
});

describe("statistics", () => {
  it("weekly summary reconciles with dashboard weekly hours to the second", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "Chem", weekly_target_hours: 5 });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 4 });
    await setPct(db, l.id, 25, new Date("2026-09-15T10:00:00").toISOString());
    const mk = (offsetMin: number, secs: number, node: string | null) =>
      insertSession(db, {
        node_id: node,
        cycle_id: null,
        mode: "single",
        planned_seconds: secs,
        actual_seconds: secs,
        started_at: new Date(now.getTime() - offsetMin * 60_000).toISOString(),
        ended_at: now.toISOString(),
        ended_reason: "completed",
        note: null,
      });
    await mk(60, 1500, l.id);
    await mk(120, 731, l.id);
    await mk(180, 900, null);
    const nodes = await listNodes(db);
    const sessions = await listSessions(db);
    const hist = await listPctHistory(db);
    const week = thisWeekBySubject(nodes, sessions, now);
    const summary = weeklySummary(nodes, sessions, hist, now);
    const wk = weekKey(now);
    const row = summary.find((r) => r.week_start === wk && r.subject === "Chem")!;
    expect(row.hours_logged).toBeCloseTo(week[0].hours, 6);
    expect(row.hours_logged).toBeCloseTo(2231 / 3600, 6);
    expect(row.variance).toBeCloseTo(2231 / 3600 - 5, 4);
    expect(row.pct_complete_end_of_week).toBe(25);
    const un = summary.find((r) => r.week_start === wk && r.subject === "Unassigned")!;
    expect(un.hours_logged).toBeCloseTo(0.25, 6);
    const byWeek = hoursBySubjectForWeek(nodes, sessions, now);
    expect(byWeek.get("Unassigned")).toBeCloseTo(0.25, 6);
  });

  it("session stats count, completion rate and heatmap", async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await insertSession(db, {
        node_id: null,
        cycle_id: null,
        mode: "single",
        planned_seconds: 600,
        actual_seconds: i === 2 ? 0 : 600,
        started_at: new Date(now.getTime() - i * 86_400_000).toISOString(),
        ended_at: now.toISOString(),
        ended_reason: i === 2 ? "aborted_discarded" : "completed",
        note: null,
      });
    }
    const st = sessionStats(await listSessions(db), now);
    expect(st.count).toBe(3);
    expect(st.completionRate).toBeCloseTo(2 / 3);
    expect(st.streakDays).toBe(2);
    const total = st.heatmap.flat().reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1200 / 3600, 6);
  });

  it("planned vs actual flags overrun when hours exceed estimate under 80%", async () => {
    const s = await createNode(db, { parent_id: null, name: "S", unit: "hours" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 1 });
    await setPct(db, l.id, 30);
    await insertSession(db, {
      node_id: l.id,
      cycle_id: null,
      mode: "single",
      planned_seconds: 7200,
      actual_seconds: 7200,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      ended_reason: "completed",
      note: null,
    });
    const rows = plannedVsActual(await listNodes(db), await listSessions(db));
    expect(rows.find((r) => r.id === l.id)!.overrun).toBe(true);
    expect(rows.find((r) => r.id === s.id)!.hoursLogged).toBeCloseTo(2);
  });

  it("velocity forecasts weeks to 100 from pct_history", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "S" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 10 });
    // 10 points per week for 4 weeks
    for (let w = 4; w >= 1; w--) {
      await setPct(db, l.id, (5 - w) * 10, new Date(now.getTime() - w * 7 * 86_400_000).toISOString());
    }
    await setPct(db, l.id, 50, now.toISOString());
    const v = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now)[0];
    expect(v.velocity).toBeCloseTo(10, 5);
    expect(v.forecastWeeks).toBeCloseTo(5, 5);
  });

  it("paces a one-week-old project over that week, not over the empty weeks before it", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const born = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const s = await createNode(db, { parent_id: null, name: "Fresh", id: "fresh" });
    const l = await createNode(db, { parent_id: s.id, name: "L" });
    // Backdate creation so the project is exactly one week old.
    await db.execute("UPDATE nodes SET created_at = ? WHERE id IN (?,?)", [born, s.id, l.id]);
    await setPct(db, l.id, 35, now.toISOString());

    const v = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now).find((r) => r.subjectId === s.id)!;
    expect(v.currentPct).toBe(35);
    expect(v.basisWeeks).toBeCloseTo(1, 5);
    expect(v.velocity).toBeCloseTo(35, 5); // not 8.75
    expect(v.forecastWeeks).toBeCloseTo(65 / 35, 5); // ~2 weeks, not ~8
    expect(v.confidence).toBe("thin");
  });

  it("never averages in the weeks before a project existed", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "Old" });
    const l = await createNode(db, { parent_id: s.id, name: "L" });
    await db.execute("UPDATE nodes SET created_at = ? WHERE id IN (?,?)", [
      new Date(now.getTime() - 14 * 86_400_000).toISOString(),
      s.id,
      l.id,
    ]);
    await setPct(db, l.id, 20, new Date(now.getTime() - 7 * 86_400_000).toISOString());
    await setPct(db, l.id, 40, now.toISOString());
    // Window forced to 8 so this covers the blanking, not the auto-sizing.
    const v = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now, 8).find((r) => r.subjectId === s.id)!;
    expect(v.basisWeeks).toBeCloseTo(2, 5);
    expect(v.velocity).toBeCloseTo(20, 5);
    expect(v.weekly.length).toBe(8);
    // The chart leaves the pre-birth weeks blank rather than flat at 0.
    expect(v.weekly.slice(0, 5).every((w) => w.pct === null)).toBe(true);
    expect(v.weekly[v.weekly.length - 1].pct).toBe(40);
  });

  it("backfilled sessions move a project's start back, correcting the pace", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "Econometrics" });
    const l = await createNode(db, { parent_id: s.id, name: "L" });
    // Typed into the app today, at a percent earned over the previous month.
    await setPct(db, l.id, 27.8, now.toISOString());

    // With nothing but today's entry there is no honest rate.
    const bare = velocity(await listNodes(db), await listPctHistory(db), [], now).find((r) => r.subjectId === s.id)!;
    expect(bare.status).toBe("too-new");
    expect(bare.forecastWeeks).toBeNull();
    expect(bare.confidence).toBe("none");

    // Backfill four weeks of work; the project demonstrably started then.
    for (let d = 28; d >= 1; d -= 7) {
      const started = new Date(now.getTime() - d * 86_400_000);
      await insertSession(db, {
        node_id: l.id,
        cycle_id: null,
        mode: "single",
        planned_seconds: 3600,
        actual_seconds: 3600,
        started_at: started.toISOString(),
        ended_at: new Date(started.getTime() + 3_600_000).toISOString(),
        ended_reason: "completed",
        note: null,
      });
    }
    const v = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now).find((r) => r.subjectId === s.id)!;
    expect(v.status).toBe("ok");
    expect(v.basisWeeks).toBeCloseTo(4, 5);
    expect(v.velocity).toBeCloseTo(27.8 / 4, 5); // ~7 pts/wk, not ~65
    expect(v.forecastWeeks).toBeCloseTo((100 - 27.8) / (27.8 / 4), 5);
  });

  it("withholds a pace under three days of history rather than inventing one", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "Today" });
    const l = await createNode(db, { parent_id: s.id, name: "L" });
    await setPct(db, l.id, 48.3, now.toISOString());
    const v = velocity(await listNodes(db), await listPctHistory(db), [], now).find((r) => r.subjectId === s.id)!;
    expect(v.status).toBe("too-new");
    expect(v.velocity).toBe(0);
    expect(v.etaDate).toBeNull();
  });

  it("discarded sessions are not evidence that a project started", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "Ghost" });
    const l = await createNode(db, { parent_id: s.id, name: "L" });
    await setPct(db, l.id, 20, now.toISOString());
    const started = new Date(now.getTime() - 30 * 86_400_000);
    await insertSession(db, {
      node_id: l.id,
      cycle_id: null,
      mode: "single",
      planned_seconds: 1500,
      actual_seconds: 0, // nothing credited
      started_at: started.toISOString(),
      ended_at: started.toISOString(),
      ended_reason: "aborted_discarded",
      note: null,
    });
    const v = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now).find((r) => r.subjectId === s.id)!;
    expect(v.status).toBe("too-new");
  });

  it("sizes the chart window to the oldest project, within bounds", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const young = await createNode(db, { parent_id: null, name: "Young" });
    await db.execute("UPDATE nodes SET created_at = ? WHERE id = ?", [
      new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      young.id,
    ]);
    // A three-day-old project must not collapse the chart to a single column.
    let rows = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now);
    expect(rows[0].weekly.length).toBe(5);

    // A four-month project widens the window instead of cropping its history.
    const old = await createNode(db, { parent_id: null, name: "Old" });
    await db.execute("UPDATE nodes SET created_at = ? WHERE id = ?", [
      new Date(now.getTime() - 120 * 86_400_000).toISOString(),
      old.id,
    ]);
    rows = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now);
    expect(rows[0].weekly.length).toBe(19); // ceil(120/7) + 1

    // …but never past the cap, so a year-old project stays readable.
    await db.execute("UPDATE nodes SET created_at = ? WHERE id = ?", [
      new Date(now.getTime() - 400 * 86_400_000).toISOString(),
      old.id,
    ]);
    rows = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now);
    expect(rows[0].weekly.length).toBe(26);
  });

  it("a task added today does not retroactively lower past weeks", async () => {
    const now = new Date("2026-09-16T12:00:00");
    const s = await createNode(db, { parent_id: null, name: "Grow" });
    const a = await createNode(db, { parent_id: s.id, name: "A" });
    await db.execute("UPDATE nodes SET created_at = ? WHERE id IN (?,?)", [
      new Date(now.getTime() - 14 * 86_400_000).toISOString(),
      s.id,
      a.id,
    ]);
    await setPct(db, a.id, 100, new Date(now.getTime() - 7 * 86_400_000).toISOString());
    // A brand new sibling at 0 % must not make last week look like 50 %.
    await createNode(db, { parent_id: s.id, name: "B" });
    const v = velocity(await listNodes(db), await listPctHistory(db), await listSessions(db), now).find((r) => r.subjectId === s.id)!;
    const lastWeek = v.weekly[v.weekly.length - 2];
    expect(lastWeek.pct).toBe(100);
    expect(v.currentPct).toBe(50);
  });
});

describe("csv + xlsx", () => {
  it("round-trips nodes through CSV", async () => {
    const s = await createNode(db, { parent_id: null, name: 'Has "quotes", commas' });
    await createNode(db, { parent_id: s.id, name: "child\nline", est_effort: 3 });
    const csv = nodesCsv(await listNodes(db));
    const parsed = parseCsv(csv);
    expect(parsed.length).toBe(3);
    const imported = parseNodesCsv(csv);
    expect(imported[0].name).toBe('Has "quotes", commas');
    expect(imported[1].name).toBe("child\nline");
    expect(imported[1].est_effort).toBe(3);
    expect(imported[1].weight).toBe(1);
    expect(imported[1].rollup_mode).toBeNull();
  });

  it("workbook has every sheet with frozen headers", async () => {
    const wb = buildWorkbook([], [], [], []);
    expect(wb.SheetNames).toEqual(["Nodes", "Sessions", "PctHistory", "WeeklySummary", "Checklist", "StatusHistory"]);
    const ws = wb.Sheets["WeeklySummary"];
    expect((ws["!freeze"] as { ySplit: number }).ySplit).toBe(1);
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    expect((buf as ArrayBuffer).byteLength).toBeGreaterThan(100);
  });
});

describe("driver", () => {
  it("overlapping transactions are serialised instead of nesting", async () => {
    const subj = await createNode(db, { parent_id: null, name: "S" });
    const a = await createNode(db, { parent_id: subj.id, name: "a", est_effort: 1 });
    const b = await createNode(db, { parent_id: subj.id, name: "b", est_effort: 1 });
    await Promise.all([setPct(db, a.id, 10), setPct(db, b.id, 20), setPct(db, a.id, 30)]);
    const hist = await listPctHistory(db);
    expect(hist.length).toBe(3);
    const nodes = await listNodes(db);
    expect(nodes.find((n) => n.id === a.id)!.pct_complete).toBe(30);
  });
});

describe("database robustness", () => {
  const session = (nodeId: string | null) => ({
    node_id: nodeId,
    cycle_id: null,
    mode: "single" as const,
    planned_seconds: 60,
    actual_seconds: 60,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ended_reason: "completed" as const,
    note: null,
  });

  it("migrate is idempotent and stamps user_version inside the migration transaction", async () => {
    const [{ user_version }] = await db.select<{ user_version: number }>("PRAGMA user_version");
    expect(user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(await migrate(db)).toBe(CURRENT_SCHEMA_VERSION);
    // a half-applied v2 (weight column exists, version still 1) must not be replayed blindly:
    // the version bump and the DDL now commit together, so this state cannot arise from a crash
    const cols = await db.select<{ name: string }>("PRAGMA table_info(nodes)");
    expect(cols.map((c) => c.name)).toContain("weight");
  });

  it("refuses a database written by a newer app or a foreign SQLite file", async () => {
    const newer = await SqlJsDriver.openMemory();
    await newer.execute(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 5}`);
    await expect(migrate(newer)).rejects.toThrow(/newer StudyTracker/);
    const foreign = await SqlJsDriver.openMemory();
    await foreign.execute("CREATE TABLE invoices (id INTEGER)");
    await expect(migrate(foreign)).rejects.toThrow(/not a StudyTracker database/);
  });

  it("a session whose task was deleted while the timer ran is saved as unassigned", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 1 });
    await deleteNode(db, l.id);
    const saved = await insertSession(db, session(l.id));
    expect(saved.node_id).toBeNull();
    expect((await listSessions(db)).length).toBe(1);
    await expect(assignSessions(db, [saved.id], "missing-node")).rejects.toThrow(/no longer exists/);
  });

  it("out-of-range and NaN percents are clamped instead of violating the CHECK constraint", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 1 });
    await setPct(db, l.id, 250);
    expect((await listNodes(db)).find((n) => n.id === l.id)!.pct_complete).toBe(100);
    await setPct(db, l.id, Number.NaN);
    expect((await listNodes(db)).find((n) => n.id === l.id)!.pct_complete).toBe(0);
  });

  it("settings survive partial or malformed stored values", async () => {
    await saveSetting(db, "cycle_defaults", { workMinutes: 50 } as never);
    await saveSetting(db, "timer_presets", ["x", -1] as never);
    await saveSetting(db, "rollup_mode", "bogus" as never);
    await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'not json')");
    const st = await loadSettings(db);
    expect(st.cycle_defaults).toEqual({ ...sanitizeSettings({}).cycle_defaults, workMinutes: 50 });
    expect(st.timer_presets).toEqual([25, 50, 90]);
    expect(st.rollup_mode).toBe("equal");
    expect(st.theme).toBe("system");
  });

  it("a write issued while a transaction is open is not swallowed by its rollback", async () => {
    const failing = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO settings (key, value) VALUES ('inside', '1')");
      await new Promise((r) => setTimeout(r, 20));
      throw new Error("boom");
    });
    const outside = db.execute("INSERT INTO settings (key, value) VALUES ('outside', '1')");
    await expect(failing).rejects.toThrow("boom");
    await outside;
    const keys = (await db.select<{ key: string }>("SELECT key FROM settings ORDER BY key")).map((r) => r.key);
    expect(keys).toEqual(["outside"]);
  });

  it("nested transaction calls join the outer transaction", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const l = await createNode(db, { parent_id: s.id, name: "L", est_effort: 1 });
    await db.transaction(async (tx) => {
      await setPct(tx, l.id, 40); // setPct opens its own transaction on the handle it is given
      await tx.execute("UPDATE nodes SET name = 'renamed' WHERE id = ?", [l.id]);
    });
    const n = (await listNodes(db)).find((x) => x.id === l.id)!;
    expect(n.pct_complete).toBe(40);
    expect(n.name).toBe("renamed");
  });

  it("demoting a subject to a task clears subject-only fields", async () => {
    const a = await createNode(db, { parent_id: null, name: "A", color: "#123456", weekly_target_hours: 5 });
    const b = await createNode(db, { parent_id: null, name: "B" });
    await moveNode(db, a.id, b.id, 0);
    const moved = (await listNodes(db)).find((n) => n.id === a.id)!;
    expect(moved.color).toBeNull();
    expect(moved.weekly_target_hours).toBeNull();
    expect(moved.unit).toBeNull();
    await moveNode(db, a.id, null, 0);
    expect((await listNodes(db)).find((n) => n.id === a.id)!.unit).toBe("hours");
  });
});

/* ------------------------------------------------------------ v4: provenance */

const DAY = 86_400_000;

/** A session with everything filled in, so each test only states what it cares about. */
function session(over: Partial<Parameters<typeof insertSession>[1]> = {}) {
  const started = new Date();
  return {
    node_id: null,
    cycle_id: null,
    mode: "single" as const,
    planned_seconds: 3600,
    actual_seconds: 3600,
    started_at: started.toISOString(),
    ended_at: new Date(started.getTime() + 3600_000).toISOString(),
    ended_reason: "completed" as const,
    note: null,
    ...over,
  };
}

describe("session provenance", () => {
  it("defaults to 'unknown' rather than claiming a session was timed", async () => {
    await insertSession(db, session());
    const [row] = await listSessions(db);
    expect(row.source).toBe("unknown");
    expect(row.tz_offset).toBe(-new Date().getTimezoneOffset());
  });

  it("keeps the source it was given and round-trips it through the database", async () => {
    await insertSession(db, session({ source: "manual" }));
    await insertSession(db, session({ source: "timer" }));
    const rows = await listSessions(db);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["manual", "timer"]));
  });

  it("completion rate ignores hand-logged entries, which are 100% by construction", async () => {
    // Two timer blocks, one of them abandoned, plus a backfill that would otherwise read as perfect.
    await insertSession(db, session({ source: "timer" }));
    await insertSession(db, session({ source: "timer", ended_reason: "aborted_credited", actual_seconds: 600 }));
    await insertSession(db, session({ source: "manual" }));
    const st = sessionStats(await listSessions(db));
    expect(st.completionRate).toBeCloseTo(0.5);
    expect(st.timedCount).toBe(2);
    expect(st.sources.manual).toBe(1);
  });

  it("withholds the completion rate entirely when nothing was ever timed", async () => {
    await insertSession(db, session({ source: "manual" }));
    await insertSession(db, session({ source: "manual" }));
    const st = sessionStats(await listSessions(db));
    expect(st.completionRate).toBeNull();
    expect(st.daysLogged).toBe(1);
  });

  it("builds the heatmap from timed blocks, and says so when it has to fall back", async () => {
    // 08:00 in a zone two hours east of UTC = 06:00 UTC.
    await insertSession(db, session({ source: "timer", started_at: "2026-09-14T06:00:00.000Z", tz_offset: 120, actual_seconds: 3600 }));
    await insertSession(db, session({ source: "manual", started_at: "2026-09-14T20:00:00.000Z", tz_offset: 120 }));
    const st = sessionStats(await listSessions(db));
    expect(st.heatmapBasis).toBe("timer");
    // Monday 14 Sep 2026, hour 8 local — and nothing from the typed entry.
    expect(st.heatmap[0][8]).toBeCloseTo(1);
    expect(st.heatmap.flat().reduce((a, b) => a + b, 0)).toBeCloseTo(1);

    const manualOnly = sessionStats([(await listSessions(db)).find((r) => r.source === "manual")!]);
    expect(manualOnly.heatmapBasis).toBe("entered");
  });

  it("reads the hour from the stored offset, not from where the machine is now", async () => {
    const s = session({ source: "timer", started_at: "2026-09-14T23:30:00.000Z", tz_offset: 600, actual_seconds: 1800 });
    // 23:30 UTC at +10 is 09:30 on Tuesday, not late Monday.
    const st = sessionStats([{ ...s, id: "x", source: "timer", tz_offset: 600 }]);
    expect(st.heatmap[1][9]).toBeCloseTo(0.5);
  });
});

describe("status", () => {
  it("records a blocked transition and refuses to write the same status twice", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const t = await createNode(db, { parent_id: s.id, name: "T" });
    expect(await setStatus(db, t.id, "blocked", "waiting on the textbook")).not.toBeNull();
    expect(await setStatus(db, t.id, "blocked")).toBeNull();
    expect(await setStatus(db, t.id, null)).not.toBeNull();
    const rows = await listStatusHistory(db, t.id);
    expect(rows.map((r) => r.status)).toEqual(["blocked", null]);
    expect(rows[0].note).toBe("waiting on the textbook");
    expect((await listNodes(db)).find((n) => n.id === t.id)!.status).toBeNull();
  });

  it("undo-delete brings the status history back with the subtree", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const t = await createNode(db, { parent_id: s.id, name: "T" });
    await setStatus(db, t.id, "blocked", "waiting");
    const snap = await snapshotSubtree(db, s.id);
    expect(snap.statusHistory).toHaveLength(1);
    await deleteNode(db, s.id);
    expect(await listStatusHistory(db)).toHaveLength(0);
    await restoreSubtree(db, snap, {});
    expect(await listStatusHistory(db)).toHaveLength(1);
  });
});

describe("aging work", () => {
  it("flags a quiet task and leaves a freshly touched one alone", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const s = await createNode(db, { parent_id: null, name: "S" });
    const stale = await createNode(db, { parent_id: s.id, name: "Stale" });
    const fresh = await createNode(db, { parent_id: s.id, name: "Fresh" });
    await setPct(db, stale.id, 30, new Date(now.getTime() - (IDLE_DAYS + 6) * DAY).toISOString());
    await setPct(db, fresh.id, 30, new Date(now.getTime() - 2 * DAY).toISOString());
    const rows = agingWip(await listNodes(db), await listPctHistory(db), [], [], now);
    expect(rows.map((r) => r.name)).toEqual(["Stale"]);
    expect(rows[0].flags).toContain("idle");
    expect(rows[0].idleDays).toBeCloseTo(IDLE_DAYS + 6, 0);
  });

  it("counts hours logged after the fact as activity on the day the work happened", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const s = await createNode(db, { parent_id: null, name: "S" });
    const t = await createNode(db, { parent_id: s.id, name: "T" });
    await setPct(db, t.id, 30, new Date(now.getTime() - 40 * DAY).toISOString());
    // Without any hours it reads as quiet for forty days.
    expect(agingWip(await listNodes(db), await listPctHistory(db), [], [], now)[0].flags).toContain("idle");
    // Typed in today, but describing work done three days ago: still recent work.
    await insertSession(db, session({ node_id: t.id, source: "manual", started_at: new Date(now.getTime() - 3 * DAY).toISOString() }));
    const rows = agingWip(await listNodes(db), await listPctHistory(db), await listSessions(db), [], now);
    expect(rows.find((r) => r.name === "T")).toBeUndefined();
  });

  it("separates blocked work from work that merely went quiet", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const s = await createNode(db, { parent_id: null, name: "S" });
    const t = await createNode(db, { parent_id: s.id, name: "T" });
    await setPct(db, t.id, 40, new Date(now.getTime() - 30 * DAY).toISOString());
    await setStatus(db, t.id, "blocked", "waiting on a reply", new Date(now.getTime() - 10 * DAY).toISOString());
    const rows = agingWip(await listNodes(db), await listPctHistory(db), [], await listStatusHistory(db), now);
    expect(rows[0].flags[0]).toBe("blocked");
    expect(rows[0].blockedDays).toBeCloseTo(10, 0);
  });

  it("measures a task against the p85 of finished ones, and borrows the pool under minimum support", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const s = await createNode(db, { parent_id: null, name: "S" });
    // Five finished tasks that each took about two days.
    for (let i = 0; i < 5; i++) {
      const d = await createNode(db, { parent_id: s.id, name: `done${i}` });
      await setPct(db, d.id, 50, new Date(now.getTime() - (60 - i) * DAY).toISOString());
      await setPct(db, d.id, 100, new Date(now.getTime() - (58 - i) * DAY).toISOString());
    }
    const open = await createNode(db, { parent_id: s.id, name: "Open" });
    await setPct(db, open.id, 20, new Date(now.getTime() - 9 * DAY).toISOString());
    const rows = agingWip(await listNodes(db), await listPctHistory(db), [], [], now);
    const row = rows.find((r) => r.name === "Open")!;
    expect(row.typicalFrom).toBe("project");
    expect(row.typicalDays).toBeCloseTo(2, 1);
    expect(row.flags).toContain("overrun");
  });

  it("flags a task that never started after the day it was meant to", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const s = await createNode(db, { parent_id: null, name: "S" });
    await createNode(db, { parent_id: s.id, name: "Late start", planned_start: "2026-09-01" });
    await createNode(db, { parent_id: s.id, name: "Future", planned_start: "2026-12-01" });
    const rows = agingWip(await listNodes(db), await listPctHistory(db), [], [], now);
    expect(rows.map((r) => r.name)).toEqual(["Late start"]);
    expect(rows[0].flags).toEqual(["not-started"]);
  });
});

describe("estimate bias and rework", () => {
  it("reports actual over estimate as a log-median ratio, over finished tasks only", async () => {
    const s = await createNode(db, { parent_id: null, name: "S", unit: "hours", hours_per_unit: 1 });
    // Three finished tasks estimated at 1h that each took 2h, and one unfinished
    // sink that would drag the ratio if it were counted.
    for (let i = 0; i < 3; i++) {
      const t = await createNode(db, { parent_id: s.id, name: `t${i}`, est_effort: 1 });
      await setPct(db, t.id, 100);
      await insertSession(db, session({ node_id: t.id, actual_seconds: 7200 }));
    }
    const open = await createNode(db, { parent_id: s.id, name: "open", est_effort: 10 });
    await setPct(db, open.id, 10);
    await insertSession(db, session({ node_id: open.id, actual_seconds: 3600 }));

    const rows = estimateBias(await listNodes(db), await listSessions(db));
    expect(rows[0].subjectId).toBeNull();
    expect(rows[0].samples).toBe(3);
    expect(rows[0].ratio).toBeCloseTo(2, 6);
    // Under minimum support the project borrows the pooled ratio rather than publishing its own.
    expect(rows[1].fallback).toBe(true);
    expect(rows[1].ratio).toBeCloseTo(2, 6);
  });

  it("2x over and 2x under cancel out instead of averaging above 1", async () => {
    const s = await createNode(db, { parent_id: null, name: "S", unit: "hours", hours_per_unit: 1 });
    const over = await createNode(db, { parent_id: s.id, name: "over", est_effort: 1 });
    const under = await createNode(db, { parent_id: s.id, name: "under", est_effort: 4 });
    await setPct(db, over.id, 100);
    await setPct(db, under.id, 100);
    await insertSession(db, session({ node_id: over.id, actual_seconds: 7200 })); // 2x over
    await insertSession(db, session({ node_id: under.id, actual_seconds: 7200 })); // 2x under
    const rows = estimateBias(await listNodes(db), await listSessions(db));
    expect(rows[0].ratio).toBeCloseTo(1, 6);
  });

  it("counts percentages that go backwards as rework", async () => {
    const s = await createNode(db, { parent_id: null, name: "S" });
    const t = await createNode(db, { parent_id: s.id, name: "T" });
    await setPct(db, t.id, 40);
    await setPct(db, t.id, 80);
    await setPct(db, t.id, 50); // redone
    const rows = reworkRate(await listNodes(db), await listPctHistory(db));
    expect(rows[0].moves).toBe(3);
    expect(rows[0].backwards).toBe(1);
    expect(rows[0].pointsLost).toBeCloseTo(30);
    expect(rows[0].tasks).toBe(1);
    expect(rows[0].rate).toBeCloseTo(1 / 3);
  });

  it("quantile interpolates and survives an empty list", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([5], 0.85)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4, 100], 0.5)).toBe(3); // the outlier does not move it
  });
});

describe("upgrading a real database", () => {
  it("v3 data survives the move to v4 and its sessions read as 'unknown'", async () => {
    const old = await SqlJsDriver.openMemory();
    // Build a v3 database the way the shipped app left it, then upgrade.
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      for (const stmt of m.statements) await old.execute(stmt);
      await old.execute(`PRAGMA user_version = ${m.version}`);
    }
    await old.execute(
      `INSERT INTO nodes (id,parent_id,name,depth,sort_order,est_effort,pct_complete,deadline,created_at,updated_at,weight,rollup_mode,unit,hours_per_unit,weekly_target_hours,color)
       VALUES ('n1',NULL,'Old project',0,0,NULL,40,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',1,NULL,'hours',1,NULL,NULL)`,
    );
    await old.execute(
      `INSERT INTO sessions (id,node_id,cycle_id,mode,planned_seconds,actual_seconds,started_at,ended_at,ended_reason,note)
       VALUES ('s1','n1',NULL,'single',1500,1500,'2026-01-02T09:00:00.000Z','2026-01-02T09:25:00.000Z','completed',NULL)`,
    );

    expect(await migrate(old)).toBe(CURRENT_SCHEMA_VERSION);
    const [session] = await listSessions(old);
    expect(session.source).toBe("unknown");
    expect(session.tz_offset).toBeNull();
    const [node] = await listNodes(old);
    expect(node.status).toBeNull();
    expect(node.planned_start).toBeNull();
    // The old row still counts as evidence of work, and as a timed block.
    expect(sessionStats([session]).timedCount).toBe(1);
  });
});
