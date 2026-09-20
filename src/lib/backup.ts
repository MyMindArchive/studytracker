/**
 * One file that holds everything: the tree, the logged sessions, both
 * histories, the checklists and the settings. A backup has to survive moving
 * between the desktop app and the browser build, so the format is plain JSON
 * rather than the SQLite file — but a `.db` and the CSV mirror can both be
 * read back into the same shape, so anything the app ever wrote out can be
 * restored.
 */
import type { ChecklistItem, DbNode, PctHistory, Session, StatusHistory } from "../types";
import {
  csvHasColumns,
  parseChecklistCsv,
  parseNodesFullCsv,
  parsePctHistoryCsv,
  parseSessionsCsv,
  parseStatusHistoryCsv,
} from "./csv";

export const BACKUP_FORMAT = "studytracker-backup";
/** Envelope version; bumped only when the shape below changes. */
export const BACKUP_VERSION = 1;

export interface BackupData {
  nodes: DbNode[];
  sessions: Session[];
  pct_history: PctHistory[];
  status_history: StatusHistory[];
  checklist: ChecklistItem[];
  /** raw setting values; sanitised by `repo.sanitizeSettings` when loaded */
  settings: Record<string, unknown>;
}

export interface BackupFile extends BackupData {
  format: string;
  version: number;
  /** database schema version at the time of export */
  schema_version: number;
  exported_at: string;
}

/**
 * Where the data lives is a property of this machine, not of the data, so it
 * is left out: restoring a Mac backup on Windows must not point the app at a
 * folder that does not exist.
 */
const SKIPPED_SETTINGS = new Set(["storage_path"]);

export function buildBackup(data: BackupData, schemaVersion: number, now = new Date()): BackupFile {
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data.settings)) if (!SKIPPED_SETTINGS.has(k)) settings[k] = v;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schema_version: schemaVersion,
    exported_at: now.toISOString(),
    nodes: data.nodes,
    sessions: data.sessions,
    pct_history: data.pct_history,
    status_history: data.status_history,
    checklist: data.checklist,
    settings,
  };
}

export function backupFilename(now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  const t = now.toISOString().slice(11, 16).replace(":", "");
  return `studytracker-backup-${d}-${t}.json`;
}

export function backupJson(b: BackupFile): string {
  return JSON.stringify(b, null, 2);
}

export interface BackupCounts {
  nodes: number;
  sessions: number;
  history: number;
  checklist: number;
  settings: number;
}

export function backupCounts(d: BackupData): BackupCounts {
  return {
    nodes: d.nodes.length,
    sessions: d.sessions.length,
    history: d.pct_history.length + d.status_history.length,
    checklist: d.checklist.length,
    settings: Object.keys(d.settings).length,
  };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Reads a backup file. Forgiving about what it does not recognise (a file
 * written by a later version should still restore what this one understands)
 * but blunt about a file that is not a backup at all, because the alternative
 * is wiping someone's data over a mis-picked file.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not a StudyTracker backup — it is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("That file is not a StudyTracker backup.");
  const o = raw as Record<string, unknown>;
  if (typeof o.format === "string" && o.format !== BACKUP_FORMAT) {
    throw new Error(`That file says it is "${o.format}", not a StudyTracker backup.`);
  }
  if (!Array.isArray(o.nodes) && !Array.isArray(o.sessions)) {
    throw new Error("That file is not a StudyTracker backup — it has no projects or sessions in it.");
  }
  const settings = typeof o.settings === "object" && o.settings !== null && !Array.isArray(o.settings) ? (o.settings as Record<string, unknown>) : {};
  return {
    format: BACKUP_FORMAT,
    version: typeof o.version === "number" ? o.version : BACKUP_VERSION,
    schema_version: typeof o.schema_version === "number" ? o.schema_version : 0,
    exported_at: typeof o.exported_at === "string" ? o.exported_at : new Date().toISOString(),
    nodes: asArray(o.nodes) as DbNode[],
    sessions: asArray(o.sessions) as Session[],
    pct_history: asArray(o.pct_history ?? o.history) as PctHistory[],
    status_history: asArray(o.status_history) as StatusHistory[],
    checklist: asArray(o.checklist ?? o.checklist_items) as ChecklistItem[],
    settings,
  };
}

/** The CSV mirror files a restore can read, and the columns that identify each. */
const CSV_KINDS = [
  { key: "nodes", must: ["id", "name"], not: ["node_id", "week_start"] },
  { key: "sessions", must: ["started_at", "actual_seconds"], not: [] },
  { key: "pct_history", must: ["node_id", "pct"], not: [] },
  { key: "status_history", must: ["node_id", "changed_at", "status"], not: ["pct"] },
  { key: "checklist", must: ["node_id", "label"], not: [] },
] as const;

type CsvKind = (typeof CSV_KINDS)[number]["key"];

/**
 * Works out which mirror file is which from its header rather than its name,
 * so renamed files (`nodes (1).csv` after a second download) still land in the
 * right table. `weekly_summary.csv` is a report, not a table, and is ignored.
 */
export function classifyCsv(text: string): CsvKind | null {
  for (const k of CSV_KINDS) {
    if (csvHasColumns(text, [...k.must]) && !k.not.some((c) => csvHasColumns(text, [c]))) return k.key;
  }
  return null;
}

export class UnreadableCsvError extends Error {}

/**
 * Builds a restorable backup out of a set of exported CSVs. `nodes.csv` is
 * required — sessions and history hang off it — and anything not supplied is
 * simply restored as empty.
 */
export function backupFromCsv(files: { name: string; text: string }[], schemaVersion: number, now = new Date()): BackupFile {
  const picked = new Map<CsvKind, string>();
  const skipped: string[] = [];
  for (const f of files) {
    const kind = classifyCsv(f.text);
    if (!kind || picked.has(kind)) skipped.push(f.name);
    else picked.set(kind, f.text);
  }
  const nodesCsvText = picked.get("nodes");
  if (!nodesCsvText) {
    throw new UnreadableCsvError(
      skipped.length
        ? `None of those files look like a StudyTracker export (${skipped.join(", ")}). A restore needs nodes.csv.`
        : "A CSV restore needs nodes.csv — pick it together with sessions.csv and the other exported files.",
    );
  }
  const stamp = now.toISOString();
  const nodes = parseNodesFullCsv(nodesCsvText, stamp);
  const known = new Set(nodes.map((n) => n.id));
  const text = (k: CsvKind) => picked.get(k) ?? "";
  return buildBackup(
    {
      nodes,
      // A row pointing at a node that is not in nodes.csv would fail the
      // foreign key, so it is dropped (sessions keep their time, untagged).
      sessions: parseSessionsCsv(text("sessions"), stamp).map((s) => (s.node_id && !known.has(s.node_id) ? { ...s, node_id: null } : s)),
      pct_history: parsePctHistoryCsv(text("pct_history"), stamp).filter((r) => known.has(r.node_id)),
      status_history: parseStatusHistoryCsv(text("status_history"), stamp).filter((r) => known.has(r.node_id)),
      checklist: parseChecklistCsv(text("checklist"), stamp).filter((r) => known.has(r.node_id)),
      settings: {},
    },
    schemaVersion,
    now,
  );
}

/**
 * Parents before children, so every `parent_id` is already present when a row
 * is inserted. A node whose parent is missing is promoted to a project rather
 * than dropped: losing the nesting is recoverable, losing the work is not.
 */
export function orderNodesForInsert(nodes: DbNode[]): DbNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: DbNode[] = [];
  const done = new Set<string>();
  const visit = (n: DbNode, seen: Set<string>) => {
    if (done.has(n.id)) return;
    if (seen.has(n.id)) {
      // a parent cycle in a hand-edited file: break it at this node
      out.push({ ...n, parent_id: null, depth: 0 });
      done.add(n.id);
      return;
    }
    seen.add(n.id);
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
    if (n.parent_id && !parent) {
      out.push({ ...n, parent_id: null, depth: 0 });
      done.add(n.id);
      return;
    }
    if (parent) visit(parent, seen);
    if (done.has(n.id)) return;
    out.push(n);
    done.add(n.id);
  };
  for (const n of nodes) visit(n, new Set());
  return out;
}
