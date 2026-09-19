import type { SqlDriver } from "./driver";
import type { ChecklistItem, DbNode, MediaAsset, NodeStatus, PctHistory, RollupMode, Session, SessionSource, Settings, StatusHistory } from "../types";
import { DEFAULT_SETTINGS, ROLLUP_MODES } from "../types";
import { SKIN_IDS } from "../lib/skins";
import { uid, nowIso } from "../lib/ids";

/* ------------------------------------------------------------------ nodes */

export interface NewNodeInput {
  parent_id: string | null;
  name: string;
  est_effort?: number | null;
  deadline?: string | null;
  planned_start?: string | null;
  weight?: number;
  rollup_mode?: RollupMode | null;
  unit?: string | null;
  hours_per_unit?: number | null;
  weekly_target_hours?: number | null;
  color?: string | null;
  id?: string;
}

/** Column order shared by every INSERT so a schema change is made in one place. */
export const NODE_INSERT_COLUMNS = [
  "id",
  "parent_id",
  "name",
  "depth",
  "sort_order",
  "est_effort",
  "pct_complete",
  "deadline",
  "planned_start",
  "status",
  "created_at",
  "updated_at",
  "weight",
  "rollup_mode",
  "unit",
  "hours_per_unit",
  "weekly_target_hours",
  "color",
] as const satisfies readonly (keyof DbNode)[];

export const NODE_INSERT_SQL = `INSERT INTO nodes (${NODE_INSERT_COLUMNS.join(",")}) VALUES (${NODE_INSERT_COLUMNS.map(() => "?").join(",")})`;
export const NODE_UPSERT_SQL = NODE_INSERT_SQL.replace("INSERT INTO", "INSERT OR REPLACE INTO");

export function nodeValues(n: DbNode): unknown[] {
  return NODE_INSERT_COLUMNS.map((c) => n[c] ?? null);
}

export async function listNodes(db: SqlDriver): Promise<DbNode[]> {
  return db.select<DbNode>("SELECT * FROM nodes ORDER BY depth, sort_order, created_at");
}

export async function getNode(db: SqlDriver, id: string): Promise<DbNode | undefined> {
  const rows = await db.select<DbNode>("SELECT * FROM nodes WHERE id = ?", [id]);
  return rows[0];
}

async function nextSortOrder(db: SqlDriver, parentId: string | null): Promise<number> {
  const rows = await db.select<{ m: number | null }>(
    parentId === null
      ? "SELECT MAX(sort_order) AS m FROM nodes WHERE parent_id IS NULL"
      : "SELECT MAX(sort_order) AS m FROM nodes WHERE parent_id = ?",
    parentId === null ? [] : [parentId],
  );
  return (rows[0]?.m ?? -1) + 1;
}

export async function createNode(db: SqlDriver, input: NewNodeInput): Promise<DbNode> {
  const id = input.id ?? uid();
  const ts = nowIso();
  let depth = 0;
  if (input.parent_id) {
    const parent = await getNode(db, input.parent_id);
    if (!parent) throw new Error("Parent not found");
    depth = parent.depth + 1;
  }
  const sort = await nextSortOrder(db, input.parent_id);
  const node: DbNode = {
    id,
    parent_id: input.parent_id,
    name: input.name,
    depth,
    sort_order: sort,
    est_effort: input.est_effort ?? null,
    pct_complete: 0,
    deadline: input.deadline ?? null,
    planned_start: input.planned_start ?? null,
    status: null,
    created_at: ts,
    updated_at: ts,
    weight: input.weight ?? 1,
    rollup_mode: input.rollup_mode ?? null,
    unit: input.parent_id === null ? (input.unit ?? "hours") : null,
    hours_per_unit: input.parent_id === null ? (input.hours_per_unit ?? null) : null,
    weekly_target_hours: input.parent_id === null ? (input.weekly_target_hours ?? null) : null,
    color: input.parent_id === null ? (input.color ?? null) : null,
  };
  await db.execute(NODE_INSERT_SQL, nodeValues(node));
  // If the parent was a leaf with a percent, it now becomes a parent; its
  // stored pct is ignored by roll-up (leaves only) but we reset for clarity.
  if (input.parent_id) {
    await db.execute("UPDATE nodes SET updated_at = ? WHERE id = ?", [ts, input.parent_id]);
  }
  return node;
}

export type NodePatch = Partial<
  Pick<
    DbNode,
    "name" | "est_effort" | "deadline" | "planned_start" | "weight" | "rollup_mode" | "unit" | "hours_per_unit" | "weekly_target_hours" | "color"
  >
>;

export async function updateNode(db: SqlDriver, id: string, patch: NodePatch): Promise<void> {
  const keys = Object.keys(patch) as (keyof NodePatch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => patch[k] ?? null);
  await db.execute(`UPDATE nodes SET ${sets}, updated_at = ? WHERE id = ?`, [...vals, nowIso(), id]);
}

/** 0..100, NaN/undefined become 0 so the CHECK constraint can never reject a write. */
export function clampPct(pct: number | null | undefined): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Set a leaf's percent and append a pct_history row in one transaction. */
export async function setPct(db: SqlDriver, id: string, pct: number, changedAt = nowIso()): Promise<PctHistory> {
  const clamped = clampPct(pct);
  const hist: PctHistory = { id: uid(), node_id: id, pct: clamped, changed_at: changedAt };
  await db.transaction(async (tx) => {
    await tx.execute("UPDATE nodes SET pct_complete = ?, updated_at = ? WHERE id = ?", [clamped, changedAt, id]);
    await tx.execute("INSERT INTO pct_history (id,node_id,pct,changed_at) VALUES (?,?,?,?)", [
      hist.id,
      hist.node_id,
      hist.pct,
      hist.changed_at,
    ]);
  });
  return hist;
}

/**
 * Flag a node as blocked (or clear the flag) and append a status_history row in
 * the same transaction, so "how long was this waiting" stays answerable later.
 * Re-setting the status it already has is a no-op rather than a second row.
 */
export async function setStatus(
  db: SqlDriver,
  id: string,
  status: NodeStatus | null,
  note: string | null = null,
  changedAt = nowIso(),
): Promise<StatusHistory | null> {
  const cur = await getNode(db, id);
  if (!cur || (cur.status ?? null) === status) return null;
  const row: StatusHistory = { id: uid(), node_id: id, status, changed_at: changedAt, note };
  await db.transaction(async (tx) => {
    await tx.execute("UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?", [status, changedAt, id]);
    await tx.execute("INSERT INTO status_history (id,node_id,status,changed_at,note) VALUES (?,?,?,?,?)", [
      row.id,
      row.node_id,
      row.status,
      row.changed_at,
      row.note,
    ]);
  });
  return row;
}

export async function listStatusHistory(db: SqlDriver, nodeId?: string): Promise<StatusHistory[]> {
  return nodeId
    ? db.select<StatusHistory>("SELECT * FROM status_history WHERE node_id = ? ORDER BY changed_at", [nodeId])
    : db.select<StatusHistory>("SELECT * FROM status_history ORDER BY changed_at");
}

/** Delete a node and its whole subtree explicitly (no reliance on FK pragmas). */
export async function deleteNode(db: SqlDriver, id: string): Promise<void> {
  const snap = await snapshotSubtree(db, id);
  const ids = snap.nodes.map((n) => n.id);
  if (ids.length === 0) return;
  const q = ids.map(() => "?").join(",");
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE sessions SET node_id = NULL WHERE node_id IN (${q})`, ids);
    await tx.execute(`DELETE FROM pct_history WHERE node_id IN (${q})`, ids);
    await tx.execute(`DELETE FROM status_history WHERE node_id IN (${q})`, ids);
    await tx.execute(`DELETE FROM checklist_items WHERE node_id IN (${q})`, ids);
    // children first so the FK never dangles even with cascades disabled
    for (const n of [...snap.nodes].sort((a, b) => b.depth - a.depth)) {
      await tx.execute("DELETE FROM nodes WHERE id = ?", [n.id]);
    }
  });
}

/** Subtree snapshot used by undo-delete. */
export interface NodeSnapshot {
  nodes: DbNode[];
  pctHistory: PctHistory[];
  statusHistory: StatusHistory[];
  checklist: ChecklistItem[];
  sessionIds: string[];
}

export async function snapshotSubtree(db: SqlDriver, rootId: string): Promise<NodeSnapshot> {
  const all = await listNodes(db);
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parent_id && ids.has(n.parent_id) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  const nodes = all.filter((n) => ids.has(n.id));
  const list = [...ids];
  const q = list.map(() => "?").join(",");
  const pctHistory = list.length
    ? await db.select<PctHistory>(`SELECT * FROM pct_history WHERE node_id IN (${q})`, list)
    : [];
  const sessions = list.length
    ? await db.select<{ id: string }>(`SELECT id FROM sessions WHERE node_id IN (${q})`, list)
    : [];
  const statusHistory = list.length ? await db.select<StatusHistory>(`SELECT * FROM status_history WHERE node_id IN (${q})`, list) : [];
  const checklist = list.length ? (await db.select<ChecklistItem>(`SELECT * FROM checklist_items WHERE node_id IN (${q})`, list)).map(normaliseItem) : [];
  return { nodes, pctHistory, statusHistory, checklist, sessionIds: sessions.map((s) => s.id) };
}

export async function restoreSubtree(db: SqlDriver, snap: NodeSnapshot, sessionNodeMap: Record<string, string>): Promise<void> {
  await db.transaction(async (tx) => {
    const ordered = [...snap.nodes].sort((a, b) => a.depth - b.depth);
    for (const n of ordered) {
      await tx.execute(NODE_UPSERT_SQL, nodeValues(n));
    }
    for (const h of snap.pctHistory) {
      await tx.execute("INSERT OR REPLACE INTO pct_history (id,node_id,pct,changed_at) VALUES (?,?,?,?)", [
        h.id,
        h.node_id,
        h.pct,
        h.changed_at,
      ]);
    }
    for (const h of snap.statusHistory ?? []) {
      await tx.execute("INSERT OR REPLACE INTO status_history (id,node_id,status,changed_at,note) VALUES (?,?,?,?,?)", [
        h.id,
        h.node_id,
        h.status,
        h.changed_at,
        h.note,
      ]);
    }
    for (const it of snap.checklist ?? []) {
      await tx.execute(CHECKLIST_UPSERT_SQL, checklistValues(it));
    }
    for (const [sid, nid] of Object.entries(sessionNodeMap)) {
      await tx.execute("UPDATE sessions SET node_id = ? WHERE id = ?", [nid, sid]);
    }
  });
}

/** Move a node under a new parent at a given index among siblings. */
export async function moveNode(
  db: SqlDriver,
  id: string,
  newParentId: string | null,
  index: number,
): Promise<void> {
  const all = await listNodes(db);
  const byId = new Map(all.map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) throw new Error("Node not found");
  // Prevent dropping into own subtree
  let p: string | null = newParentId;
  while (p) {
    if (p === id) throw new Error("Cannot move a node into its own subtree");
    p = byId.get(p)?.parent_id ?? null;
  }
  const newParent = newParentId ? byId.get(newParentId) : null;
  const newDepth = newParent ? newParent.depth + 1 : 0;
  const depthDelta = newDepth - node.depth;

  const siblings = all
    .filter((n) => n.parent_id === newParentId && n.id !== id)
    .sort((a, b) => a.sort_order - b.sort_order);
  const clampedIndex = Math.max(0, Math.min(index, siblings.length));
  siblings.splice(clampedIndex, 0, node);

  const ts = nowIso();
  await db.transaction(async (tx) => {
    // subject-level fields only make sense at root
    if (newDepth === 0 && node.depth !== 0) {
      await tx.execute("UPDATE nodes SET unit = COALESCE(unit,'hours') WHERE id = ?", [id]);
    } else if (newDepth !== 0 && node.depth === 0) {
      // a subject demoted to a task keeps no subject-level fields
      await tx.execute("UPDATE nodes SET unit = NULL, hours_per_unit = NULL, weekly_target_hours = NULL, color = NULL WHERE id = ?", [id]);
    }
    await tx.execute("UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?", [newParentId, ts, id]);
    for (let i = 0; i < siblings.length; i++) {
      await tx.execute("UPDATE nodes SET sort_order = ? WHERE id = ?", [i, siblings[i].id]);
    }
    if (depthDelta !== 0) {
      // update depth of subtree
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        const n = byId.get(cur)!;
        await tx.execute("UPDATE nodes SET depth = ? WHERE id = ?", [n.depth + depthDelta, cur]);
        for (const c of all) if (c.parent_id === cur) stack.push(c.id);
      }
    }
  });
}

export async function duplicateNode(db: SqlDriver, id: string): Promise<string> {
  const snap = await snapshotSubtree(db, id);
  const idMap = new Map<string, string>();
  for (const n of snap.nodes) idMap.set(n.id, uid());
  const root = snap.nodes.find((n) => n.id === id)!;
  const sort = await nextSortOrder(db, root.parent_id);
  const ts = nowIso();
  await db.transaction(async (tx) => {
    for (const n of [...snap.nodes].sort((a, b) => a.depth - b.depth)) {
      const isRoot = n.id === id;
      await tx.execute(
        NODE_INSERT_SQL,
        nodeValues({
          ...n,
          id: idMap.get(n.id)!,
          parent_id: isRoot ? n.parent_id : idMap.get(n.parent_id!)!,
          name: isRoot ? `${n.name} (copy)` : n.name,
          sort_order: isRoot ? sort : n.sort_order,
          pct_complete: 0,
          created_at: ts,
          updated_at: ts,
        }),
      );
    }
    for (const it of snap.checklist) {
      await tx.execute(CHECKLIST_INSERT_SQL, checklistValues({ ...it, id: uid(), node_id: idMap.get(it.node_id)!, done: false, created_at: ts }));
    }
  });
  return idMap.get(id)!;
}

/* -------------------------------------------------------------- checklist */

const CHECKLIST_COLUMNS = ["id", "node_id", "label", "done", "sort_order", "created_at"] as const;
const CHECKLIST_INSERT_SQL = `INSERT INTO checklist_items (${CHECKLIST_COLUMNS.join(",")}) VALUES (${CHECKLIST_COLUMNS.map(() => "?").join(",")})`;
const CHECKLIST_UPSERT_SQL = CHECKLIST_INSERT_SQL.replace("INSERT INTO", "INSERT OR REPLACE INTO");

function checklistValues(it: ChecklistItem): unknown[] {
  return [it.id, it.node_id, it.label, it.done ? 1 : 0, it.sort_order, it.created_at];
}
/** SQLite stores `done` as 0/1. */
function normaliseItem(r: ChecklistItem): ChecklistItem {
  return { ...r, done: Boolean(r.done) };
}

export async function listChecklist(db: SqlDriver): Promise<ChecklistItem[]> {
  const rows = await db.select<ChecklistItem>("SELECT * FROM checklist_items ORDER BY node_id, sort_order, created_at");
  return rows.map(normaliseItem);
}

export async function addChecklistItem(db: SqlDriver, nodeId: string, label: string): Promise<ChecklistItem> {
  const rows = await db.select<{ m: number | null }>("SELECT MAX(sort_order) AS m FROM checklist_items WHERE node_id = ?", [nodeId]);
  const item: ChecklistItem = { id: uid(), node_id: nodeId, label, done: false, sort_order: (rows[0]?.m ?? -1) + 1, created_at: nowIso() };
  await db.execute(CHECKLIST_INSERT_SQL, checklistValues(item));
  return item;
}

export async function updateChecklistItem(db: SqlDriver, id: string, patch: { label?: string; done?: boolean }): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.label !== undefined) (sets.push("label = ?"), vals.push(patch.label));
  if (patch.done !== undefined) (sets.push("done = ?"), vals.push(patch.done ? 1 : 0));
  if (!sets.length) return;
  await db.execute(`UPDATE checklist_items SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
}

export async function deleteChecklistItem(db: SqlDriver, id: string): Promise<void> {
  await db.execute("DELETE FROM checklist_items WHERE id = ?", [id]);
}

export async function restoreChecklistItem(db: SqlDriver, it: ChecklistItem): Promise<void> {
  await db.execute(CHECKLIST_UPSERT_SQL, checklistValues(it));
}

/** Percent implied by a checklist: done ÷ total, or null when there are no items. */
export function checklistPct(items: ChecklistItem[]): number | null {
  if (items.length === 0) return null;
  return (items.filter((i) => i.done).length / items.length) * 100;
}

/**
 * Write the percent a task's checklist implies, through setPct so the change
 * lands in pct_history like any other edit. No-op without items or when the
 * value is already current.
 */
export async function syncChecklistPct(db: SqlDriver, nodeId: string): Promise<void> {
  const items = (await db.select<ChecklistItem>("SELECT * FROM checklist_items WHERE node_id = ?", [nodeId])).map(normaliseItem);
  const pct = checklistPct(items);
  if (pct === null) return;
  const node = await getNode(db, nodeId);
  if (!node || Math.abs(node.pct_complete - pct) < 1e-9) return;
  await setPct(db, nodeId, pct);
}

/* ------------------------------------------------------------ pct_history */

export async function listPctHistory(db: SqlDriver, nodeId?: string): Promise<PctHistory[]> {
  if (nodeId) {
    return db.select<PctHistory>("SELECT * FROM pct_history WHERE node_id = ? ORDER BY changed_at", [nodeId]);
  }
  return db.select<PctHistory>("SELECT * FROM pct_history ORDER BY changed_at");
}

/* --------------------------------------------------------------- sessions */

export async function listSessions(db: SqlDriver): Promise<Session[]> {
  return db.select<Session>("SELECT * FROM sessions ORDER BY started_at DESC");
}

/** Column order shared by both session inserts. */
const SESSION_INSERT_SQL = `INSERT INTO sessions (id,node_id,cycle_id,mode,planned_seconds,actual_seconds,started_at,ended_at,ended_reason,note,source,tz_offset)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

function sessionValues(s: Session): unknown[] {
  return [s.id, s.node_id, s.cycle_id, s.mode, s.planned_seconds, s.actual_seconds, s.started_at, s.ended_at, s.ended_reason, s.note, s.source, s.tz_offset];
}

/** Minutes east of UTC right now (the sign people expect: Berlin in summer = +120). */
export function tzOffsetNow(d = new Date()): number {
  return -d.getTimezoneOffset();
}

export type SessionInput = Omit<Session, "id" | "source" | "tz_offset"> & {
  id?: string;
  source?: SessionSource;
  tz_offset?: number | null;
};

/** Fill in the fields every session needs and clamp the numbers. */
function normaliseSession(s: SessionInput): Session {
  return {
    ...s,
    id: s.id ?? uid(),
    // An unlabelled row is an import in all but name, so it is never called a
    // timer block: nothing downstream should treat it as a countdown that ran.
    source: s.source ?? "unknown",
    tz_offset: s.tz_offset ?? tzOffsetNow(),
    planned_seconds: Math.max(0, Math.round(Number(s.planned_seconds) || 0)),
    actual_seconds: Math.max(0, Math.round(Number(s.actual_seconds) || 0)),
  };
}

export async function insertSession(db: SqlDriver, s: SessionInput): Promise<Session> {
  const full = normaliseSession(s);
  // The task may have been deleted while the countdown ran; the session must
  // still be saved (it lands in the inbox) rather than fail the FK constraint.
  if (full.node_id && !(await getNode(db, full.node_id))) full.node_id = null;
  await db.execute(SESSION_INSERT_SQL, sessionValues(full));
  return full;
}

/**
 * Insert many sessions in one transaction — used when backfilling time that
 * was worked before (or outside) the timer, which can be dozens of rows.
 */
export async function insertSessions(db: SqlDriver, list: SessionInput[]): Promise<Session[]> {
  if (list.length === 0) return [];
  const known = new Set((await listNodes(db)).map((n) => n.id));
  const full: Session[] = list.map((s) => ({
    ...normaliseSession(s),
    node_id: s.node_id && known.has(s.node_id) ? s.node_id : null,
  }));
  await db.transaction(async (tx) => {
    for (const s of full) await tx.execute(SESSION_INSERT_SQL, sessionValues(s));
  });
  return full;
}

export async function assignSessions(db: SqlDriver, sessionIds: string[], nodeId: string | null): Promise<void> {
  if (sessionIds.length === 0) return;
  if (nodeId && !(await getNode(db, nodeId))) throw new Error("That task no longer exists");
  await db.transaction(async (tx) => {
    for (const id of sessionIds) {
      await tx.execute("UPDATE sessions SET node_id = ? WHERE id = ?", [nodeId, id]);
    }
  });
}

export async function updateSessionNote(db: SqlDriver, id: string, note: string | null): Promise<void> {
  await db.execute("UPDATE sessions SET note = ? WHERE id = ?", [note, id]);
}

export async function deleteSession(db: SqlDriver, id: string): Promise<void> {
  await db.execute("DELETE FROM sessions WHERE id = ?", [id]);
}

/* --------------------------------------------------------------- settings */

export async function loadSettings(db: SqlDriver): Promise<Settings> {
  const rows = await db.select<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return sanitizeSettings(out);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finiteOr = (v: unknown, d: number, min = 0): number => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : d);
const isMedia = (v: unknown): v is MediaAsset =>
  isRecord(v) && typeof v.name === "string" && typeof v.data === "string" && v.data.startsWith("data:");

/**
 * Settings rows are free-form JSON written by older versions or by hand; a
 * missing nested key or a wrong type must never take the UI down.
 */
export function sanitizeSettings(raw: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS;
  const cd = isRecord(raw.cycle_defaults) ? raw.cycle_defaults : {};
  const presets = Array.isArray(raw.timer_presets)
    ? raw.timer_presets.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  return {
    daily_target_hours: finiteOr(raw.daily_target_hours, d.daily_target_hours),
    storage_path: typeof raw.storage_path === "string" ? raw.storage_path : d.storage_path,
    timer_presets: presets.length ? presets : d.timer_presets,
    cycle_defaults: {
      workMinutes: finiteOr(cd.workMinutes, d.cycle_defaults.workMinutes, 1),
      breakMinutes: finiteOr(cd.breakMinutes, d.cycle_defaults.breakMinutes),
      rounds: Math.max(1, Math.round(finiteOr(cd.rounds, d.cycle_defaults.rounds, 1))),
      longBreakEvery: Math.round(finiteOr(cd.longBreakEvery, d.cycle_defaults.longBreakEvery)),
      longBreakMinutes: finiteOr(cd.longBreakMinutes, d.cycle_defaults.longBreakMinutes),
    },
    theme: oneOf(raw.theme, ["system", "light", "dark"] as const, d.theme),
    // Read from the registry rather than a second copy of the list: a skin added
    // to SKINS but missed here was silently reverted to the default on save.
    skin: oneOf(raw.skin, SKIN_IDS, d.skin),
    sound: typeof raw.sound === "boolean" ? raw.sound : d.sound,
    unassigned_badge_threshold_hours: finiteOr(raw.unassigned_badge_threshold_hours, d.unassigned_badge_threshold_hours),
    csv_mirror: typeof raw.csv_mirror === "boolean" ? raw.csv_mirror : d.csv_mirror,
    rollup_mode: oneOf(raw.rollup_mode, ROLLUP_MODES, d.rollup_mode),
    timer_background: isMedia(raw.timer_background) ? raw.timer_background : null,
    timer_overlay: Math.min(0.9, finiteOr(raw.timer_overlay, d.timer_overlay)),
    timer_overlay_tone: oneOf(raw.timer_overlay_tone, ["dark", "light"] as const, d.timer_overlay_tone),
    timer_background_quality: oneOf(raw.timer_background_quality, ["1080p", "2k"] as const, d.timer_background_quality),
    bell: isMedia(raw.bell) ? raw.bell : null,
  };
}

export async function saveSetting<K extends keyof Settings>(db: SqlDriver, key: K, value: Settings[K]): Promise<void> {
  await db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    JSON.stringify(value),
  ]);
}
