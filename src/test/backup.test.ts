import { describe, it, expect, beforeEach } from "vitest";
import { SqlJsDriver } from "../db/sqljs";
import { migrate, CURRENT_SCHEMA_VERSION } from "../db/migrations";
import {
  addChecklistItem,
  createNode,
  insertSession,
  listChecklist,
  listNodes,
  listPctHistory,
  listSessions,
  listStatusHistory,
  loadSettings,
  readAll,
  replaceAll,
  saveSetting,
  setPct,
  setStatus,
} from "../db/repo";
import { backupCounts, backupFromCsv, buildBackup, classifyCsv, orderNodesForInsert, parseBackup } from "../lib/backup";
import { backupFromFiles, isSqliteBytes } from "../lib/restore";
import { mirrorFiles } from "../lib/mirror";
import type { DbNode } from "../types";

let db: SqlJsDriver;
beforeEach(async () => {
  db = await SqlJsDriver.openMemory();
  await migrate(db);
});

/** A small but complete database: nesting, percent, a block of time, both histories, a checklist. */
async function seed() {
  const math = await createNode(db, { parent_id: null, name: "Math", unit: "chapters", hours_per_unit: 2, weekly_target_hours: 5, color: "#6366f1" });
  const ch1 = await createNode(db, { parent_id: math.id, name: 'Ch 1 "limits", part a', est_effort: 10, deadline: "2026-10-01" });
  const ch2 = await createNode(db, { parent_id: math.id, name: "Ch 2", est_effort: 4 });
  const drill = await createNode(db, { parent_id: ch1.id, name: "Drills" });
  await setPct(db, ch1.id, 50);
  await setPct(db, ch2.id, 100);
  await setStatus(db, drill.id, "blocked", "waiting on the textbook");
  await addChecklistItem(db, drill.id, "problems 1-10");
  await insertSession(db, {
    node_id: ch1.id,
    cycle_id: null,
    mode: "single",
    planned_seconds: 1500,
    actual_seconds: 1500,
    started_at: "2026-09-18T08:00:00.000Z",
    ended_at: "2026-09-18T08:25:00.000Z",
    ended_reason: "completed",
    note: "good, focused block",
    source: "timer",
  });
  // untagged time: it lives in the inbox and must survive a round trip too
  await insertSession(db, {
    node_id: null,
    cycle_id: null,
    mode: "single",
    planned_seconds: 900,
    actual_seconds: 800,
    started_at: "2026-09-19T08:00:00.000Z",
    ended_at: "2026-09-19T08:15:00.000Z",
    ended_reason: "aborted_credited",
    note: null,
    source: "manual",
  });
  await saveSetting(db, "daily_target_hours", 6);
  await saveSetting(db, "timer_presets", [30, 60]);
  return { math, ch1, ch2, drill };
}

describe("backup round trip", () => {
  it("a JSON backup restores the database exactly", async () => {
    const ids = await seed();
    const before = await readAll(db);
    const text = JSON.stringify(buildBackup(before, CURRENT_SCHEMA_VERSION));

    // wipe: a restore has to work on an empty app, not just as a merge
    await replaceAll(db, { nodes: [], sessions: [], pct_history: [], status_history: [], checklist: [], settings: {} });
    expect(await listNodes(db)).toHaveLength(0);
    expect(await listSessions(db)).toHaveLength(0);

    await replaceAll(db, parseBackup(text));
    const after = await readAll(db);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.pct_history).toEqual(before.pct_history);
    expect(after.status_history).toEqual(before.status_history);
    expect(after.checklist).toEqual(before.checklist);
    expect((await loadSettings(db)).daily_target_hours).toBe(6);
    expect((await loadSettings(db)).timer_presets).toEqual([30, 60]);
    expect((await listNodes(db)).find((n) => n.id === ids.drill.id)!.status).toBe("blocked");
  });

  it("restores into a different, non-empty database without keeping any of its rows", async () => {
    await seed();
    const backup = buildBackup(await readAll(db), CURRENT_SCHEMA_VERSION);

    const other = await SqlJsDriver.openMemory();
    await migrate(other);
    const junk = await createNode(other, { parent_id: null, name: "Old project" });
    await insertSession(other, {
      node_id: junk.id,
      cycle_id: null,
      mode: "single",
      planned_seconds: 60,
      actual_seconds: 60,
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:01:00.000Z",
      ended_reason: "completed",
      note: null,
      source: "timer",
    });
    await replaceAll(other, backup);

    expect((await listNodes(other)).map((n) => n.name)).not.toContain("Old project");
    expect(await listNodes(other)).toHaveLength(backup.nodes.length);
    expect(await listSessions(other)).toHaveLength(backup.sessions.length);
    expect(await listPctHistory(other)).toHaveLength(backup.pct_history.length);
    expect(await listStatusHistory(other)).toHaveLength(backup.status_history.length);
    expect(await listChecklist(other)).toHaveLength(backup.checklist.length);
  });

  it("the storage path stays with the machine, not the backup", async () => {
    await saveSetting(db, "storage_path", "/Users/someone/StudyTracker/studytracker.db");
    const backup = buildBackup(await readAll(db), CURRENT_SCHEMA_VERSION);
    expect(backup.settings).not.toHaveProperty("storage_path");

    const other = await SqlJsDriver.openMemory();
    await migrate(other);
    await saveSetting(other, "storage_path", "C:\\Users\\me\\StudyTracker\\studytracker.db");
    await replaceAll(other, backup);
    expect((await loadSettings(other)).storage_path).toBe("C:\\Users\\me\\StudyTracker\\studytracker.db");
  });
});

describe("restoring the downloaded CSVs", () => {
  it("brings back the tree, the sessions and the history", async () => {
    await seed();
    const before = await readAll(db);
    const files = mirrorFiles({
      nodes: before.nodes,
      sessions: before.sessions,
      history: before.pct_history,
      checklist: before.checklist,
      statusHistory: before.status_history,
    });
    const picked = Object.entries(files).map(([name, text]) => ({ name, text }));

    const backup = backupFromCsv(picked, CURRENT_SCHEMA_VERSION);
    await replaceAll(db, { ...backup, settings: before.settings });
    const after = await readAll(db);

    expect(after.nodes.map((n) => n.name).sort()).toEqual(before.nodes.map((n) => n.name).sort());
    expect(after.nodes).toEqual(before.nodes);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.pct_history).toEqual(before.pct_history);
    expect(after.status_history).toEqual(before.status_history);
    expect(after.checklist).toEqual(before.checklist);
  });

  it("leaves the settings alone, because the CSVs carry none", async () => {
    await seed();
    const before = await readAll(db);
    const files = mirrorFiles({ nodes: before.nodes, sessions: before.sessions, history: before.pct_history });
    await replaceAll(
      db,
      backupFromCsv(
        Object.entries(files).map(([name, text]) => ({ name, text })),
        CURRENT_SCHEMA_VERSION,
      ),
    );
    // the restore dialog says targets and presets stay as they are: they do
    expect((await loadSettings(db)).daily_target_hours).toBe(6);
    expect((await loadSettings(db)).timer_presets).toEqual([30, 60]);
  });

  it("recognises each mirror file by its header, whatever it was renamed to", () => {
    const files = mirrorFiles({ nodes: [], sessions: [], history: [], checklist: [], statusHistory: [] });
    // headers alone are enough: an empty export still classifies
    expect(classifyCsv(files["nodes.csv"])).toBe("nodes");
    expect(classifyCsv(files["sessions.csv"])).toBe("sessions");
    expect(classifyCsv(files["pct_history.csv"])).toBe("pct_history");
    expect(classifyCsv(files["status_history.csv"])).toBe("status_history");
    expect(classifyCsv(files["checklist.csv"])).toBe("checklist");
    expect(classifyCsv(files["weekly_summary.csv"])).toBe(null);
  });

  it("says what is missing when nodes.csv was not picked", async () => {
    await seed();
    const before = await readAll(db);
    const files = mirrorFiles({ nodes: before.nodes, sessions: before.sessions, history: before.pct_history });
    expect(() => backupFromCsv([{ name: "sessions.csv", text: files["sessions.csv"] }], CURRENT_SCHEMA_VERSION)).toThrow(/nodes\.csv/);
  });

  it("keeps time logged against a task that is not in nodes.csv, untagged", async () => {
    const { ch1 } = await seed();
    const before = await readAll(db);
    const files = mirrorFiles({ nodes: before.nodes.filter((n) => n.id !== ch1.id), sessions: before.sessions, history: [] });
    const backup = backupFromCsv(
      Object.entries(files).map(([name, text]) => ({ name, text })),
      CURRENT_SCHEMA_VERSION,
    );
    expect(backup.sessions).toHaveLength(before.sessions.length);
    expect(backup.sessions.every((s) => s.node_id === null)).toBe(true);
  });
});

describe("restoring a .db file", () => {
  it("reads a database file the app downloaded", async () => {
    await seed();
    const before = await readAll(db);
    const bytes = db.exportBytes();
    expect(isSqliteBytes(bytes)).toBe(true);

    const target = await SqlJsDriver.openMemory();
    await migrate(target);
    const backup = await backupFromFiles([{ name: "studytracker.db", bytes }], CURRENT_SCHEMA_VERSION);
    await replaceAll(target, backup);
    const after = await readAll(target);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.sessions).toEqual(before.sessions);
    expect((await loadSettings(target)).daily_target_hours).toBe(6);
  });

  it("refuses a file that is not a database", async () => {
    const bytes = new TextEncoder().encode("hello, this is not a database\n");
    await expect(backupFromFiles([{ name: "notes.txt", bytes }], CURRENT_SCHEMA_VERSION)).rejects.toThrow();
  });
});

describe("picking the right reader", () => {
  it("routes json, sqlite and csv by content rather than by file name", async () => {
    await seed();
    const data = await readAll(db);
    const json = new TextEncoder().encode(JSON.stringify(buildBackup(data, CURRENT_SCHEMA_VERSION)));
    expect(backupCounts(await backupFromFiles([{ name: "renamed.txt", bytes: json }], CURRENT_SCHEMA_VERSION)).nodes).toBe(data.nodes.length);

    const csv = mirrorFiles({ nodes: data.nodes, sessions: data.sessions, history: data.pct_history });
    const picked = [
      { name: "nodes (1).csv", bytes: new TextEncoder().encode(csv["nodes.csv"]) },
      { name: "sessions (1).csv", bytes: new TextEncoder().encode(csv["sessions.csv"]) },
    ];
    const fromCsv = await backupFromFiles(picked, CURRENT_SCHEMA_VERSION);
    expect(backupCounts(fromCsv).nodes).toBe(data.nodes.length);
    expect(backupCounts(fromCsv).sessions).toBe(data.sessions.length);
  });

  it("rejects a JSON file that is not a backup, before anything is written", async () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    await expect(backupFromFiles([{ name: "config.json", bytes }], CURRENT_SCHEMA_VERSION)).rejects.toThrow(/not a StudyTracker backup/);
  });
});

describe("a hand-edited backup", () => {
  it("promotes a node whose parent is missing instead of dropping it", () => {
    const node = (id: string, parent: string | null): DbNode => ({
      id,
      parent_id: parent,
      name: id,
      depth: 0,
      sort_order: 0,
      est_effort: null,
      pct_complete: 0,
      deadline: null,
      planned_start: null,
      status: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      weight: 1,
      rollup_mode: null,
      unit: null,
      hours_per_unit: null,
      weekly_target_hours: null,
      color: null,
    });
    const ordered = orderNodesForInsert([node("child", "gone"), node("root", null), node("kid", "root")]);
    expect(ordered.map((n) => n.id)).toEqual(["child", "root", "kid"]);
    expect(ordered.find((n) => n.id === "child")!.parent_id).toBe(null);
    // parents always land before their children
    expect(ordered.findIndex((n) => n.id === "root")).toBeLessThan(ordered.findIndex((n) => n.id === "kid"));
  });

  it("recomputes depth so the tree draws right even if the file disagrees", async () => {
    const backup = parseBackup(
      JSON.stringify({
        format: "studytracker-backup",
        nodes: [
          { id: "a", parent_id: null, name: "A", depth: 7, pct_complete: 0, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
          { id: "b", parent_id: "a", name: "B", depth: 0, pct_complete: 250, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        ],
        sessions: [],
      }),
    );
    await replaceAll(db, backup);
    const nodes = await listNodes(db);
    expect(nodes.find((n) => n.id === "a")!.depth).toBe(0);
    expect(nodes.find((n) => n.id === "b")!.depth).toBe(1);
    // out-of-range percent is clamped rather than failing the CHECK constraint
    expect(nodes.find((n) => n.id === "b")!.pct_complete).toBe(100);
  });

  it("leaves the database untouched when the restore fails part way", async () => {
    const before = await readAll(await seedAndReturn());
    const bad = {
      nodes: [{ id: "x", parent_id: null, name: "X", pct_complete: 0 } as unknown as DbNode],
      sessions: [],
      pct_history: [],
      status_history: [],
      checklist: [],
      // a value JSON.stringify cannot serialise: the settings write throws
      settings: { daily_target_hours: { toJSON: () => { throw new Error("boom"); } } },
    };
    await expect(replaceAll(db, bad)).rejects.toThrow();
    const after = await readAll(db);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.sessions).toEqual(before.sessions);
  });
});

async function seedAndReturn() {
  await seed();
  return db;
}
