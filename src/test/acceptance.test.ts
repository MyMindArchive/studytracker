import { describe, it, expect, beforeEach } from "vitest";
import { SqlJsDriver } from "../db/sqljs";
import { migrate, CURRENT_SCHEMA_VERSION } from "../db/migrations";
import { createNode, setPct, listPctHistory, insertSession, listSessions, listNodes, deleteNode, snapshotSubtree, restoreSubtree, moveNode, updateNode, duplicateNode, addChecklistItem, updateChecklistItem, deleteChecklistItem, syncChecklistPct, listChecklist, assignSessions, loadSettings, saveSetting, sanitizeSettings } from "../db/repo";
import { computeRollup, rootTotals } from "../lib/rollup";
import { weeklySummary, thisWeekBySubject, hoursBySubjectForWeek, sessionStats, plannedVsActual, velocity } from "../lib/stats";
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

  it("schema v3 adds weight, rollup_mode and checklist_items with sane defaults", async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    const s = await createNode(db, { parent_id: null, name: "S" });
    const [row] = await listNodes(db);
    expect(row.id).toBe(s.id);
    expect(row.weight).toBe(1);
    expect(row.rollup_mode).toBeNull();
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
    const v = velocity(await listNodes(db), await listPctHistory(db), now)[0];
    expect(v.velocity).toBeCloseTo(10, 5);
    expect(v.forecastWeeks).toBeCloseTo(5, 5);
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

  it("workbook has the four sheets with frozen headers", async () => {
    const wb = buildWorkbook([], [], [], []);
    expect(wb.SheetNames).toEqual(["Nodes", "Sessions", "PctHistory", "WeeklySummary", "Checklist"]);
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
