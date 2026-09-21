import type { ChecklistItem, DbNode, PctHistory, RollupMode, Session, StatusHistory } from "../types";
import { parsePriority, priorityOfRank, ROLLUP_MODES, SESSION_SOURCES } from "../types";
import type { WeeklySummaryRow } from "./stats";

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T & string)[]): string {
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(","));
  return [head, ...body].join("\r\n") + "\r\n";
}

export const NODE_COLUMNS: (keyof DbNode & string)[] = [
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
  "priority",
  "created_at",
  "updated_at",
  "weight",
  "rollup_mode",
  "unit",
  "hours_per_unit",
  "weekly_target_hours",
  "color",
];
export const SESSION_COLUMNS: (keyof Session & string)[] = [
  "id",
  "node_id",
  "cycle_id",
  "mode",
  "planned_seconds",
  "actual_seconds",
  "started_at",
  "ended_at",
  "ended_reason",
  "note",
  "source",
  "tz_offset",
];
export const PCT_COLUMNS: (keyof PctHistory & string)[] = ["id", "node_id", "pct", "changed_at"];
export const STATUS_COLUMNS: (keyof StatusHistory & string)[] = ["id", "node_id", "status", "changed_at", "note"];
export const CHECKLIST_COLUMNS: (keyof ChecklistItem & string)[] = ["id", "node_id", "label", "done", "sort_order", "created_at"];
export const WEEKLY_COLUMNS: (keyof WeeklySummaryRow & string)[] = [
  "week_start",
  "subject",
  "hours_logged",
  "weekly_target",
  "variance",
  "pct_complete_end_of_week",
  "pct_change",
];

/**
 * The mirror is meant to be opened in a spreadsheet, so priority goes out as
 * the word rather than the rank — "urgent" says something, 40 does not. It
 * reads back either way (see `parsePriority`), so a file edited by hand with
 * a name, a rank, or a blank still restores.
 */
export function nodesCsv(nodes: DbNode[]): string {
  const rows = nodes.map((n) => ({ ...n, priority: priorityOfRank(n.priority)?.id ?? null }));
  return toCsv(rows as unknown as Record<string, unknown>[], NODE_COLUMNS);
}
export function sessionsCsv(sessions: Session[]): string {
  return toCsv(sessions as unknown as Record<string, unknown>[], SESSION_COLUMNS);
}
export function pctHistoryCsv(h: PctHistory[]): string {
  return toCsv(h as unknown as Record<string, unknown>[], PCT_COLUMNS);
}
export function statusHistoryCsv(h: StatusHistory[]): string {
  return toCsv(h as unknown as Record<string, unknown>[], STATUS_COLUMNS);
}
export function checklistCsv(items: ChecklistItem[]): string {
  return toCsv(items.map((i) => ({ ...i, done: i.done ? 1 : 0 })) as unknown as Record<string, unknown>[], CHECKLIST_COLUMNS);
}
export function weeklySummaryCsv(rows: WeeklySummaryRow[]): string {
  return toCsv(rows as unknown as Record<string, unknown>[], WEEKLY_COLUMNS);
}

/* ------------------------------------------------------------- parsing */

/** RFC-4180-ish CSV parser (handles quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface ImportedNodeRow {
  id: string | null;
  parent_id: string | null;
  name: string;
  est_effort: number | null;
  pct_complete: number | null;
  deadline: string | null;
  planned_start: string | null;
  priority: number | null;
  weight: number | null;
  rollup_mode: RollupMode | null;
  unit: string | null;
  hours_per_unit: number | null;
  weekly_target_hours: number | null;
  color: string | null;
  sort_order: number | null;
}

export function parseNodesCsv(text: string): ImportedNodeRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (k: string) => header.indexOf(k);
  const get = (r: string[], k: string): string | null => {
    const i = idx(k);
    if (i < 0) return null;
    const v = r[i]?.trim();
    return v === undefined || v === "" ? null : v;
  };
  const num = (v: string | null) => (v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const mode = (v: string | null): RollupMode | null => (v !== null && (ROLLUP_MODES as string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as RollupMode) : null);
  return rows.slice(1).map((r) => ({
    id: get(r, "id"),
    parent_id: get(r, "parent_id"),
    name: get(r, "name") ?? "(unnamed)",
    est_effort: num(get(r, "est_effort")),
    pct_complete: num(get(r, "pct_complete")),
    deadline: get(r, "deadline"),
    planned_start: get(r, "planned_start"),
    priority: parsePriority(get(r, "priority")),
    weight: num(get(r, "weight")),
    rollup_mode: mode(get(r, "rollup_mode")),
    unit: get(r, "unit"),
    hours_per_unit: num(get(r, "hours_per_unit")),
    weekly_target_hours: num(get(r, "weekly_target_hours")),
    color: get(r, "color"),
    sort_order: num(get(r, "sort_order")),
  }));
}

/* --------------------------------------------- typed rows for every table */

/** Header-keyed view of a CSV. Keys are lower-cased; empty cells read as null. */
export function csvRows(text: string): Record<string, string | null>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string | null> = {};
    header.forEach((h, i) => {
      const v = r[i]?.trim();
      o[h] = v === undefined || v === "" ? null : v;
    });
    return o;
  });
}

/** True when the text looks like a CSV whose header carries all of `required`. */
export function csvHasColumns(text: string, required: string[]): boolean {
  const first = parseCsv(text)[0];
  if (!first) return false;
  const header = new Set(first.map((h) => h.trim().toLowerCase()));
  return required.every((c) => header.has(c));
}

const numOr = (v: string | null, d: number): number => (v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
const numOrNull = (v: string | null): number | null => (v !== null && Number.isFinite(Number(v)) ? Number(v) : null);
const boolOf = (v: string | null): boolean => v !== null && v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "no";
const oneOf = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
  v !== null && (allowed as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : fallback;

/**
 * Full node rows, as written by `nodesCsv`. Unlike `parseNodesCsv` (which
 * feeds the merge importer and deliberately leaves unknown fields alone) this
 * fills every column, so a restore puts the tree back exactly as it was.
 */
export function parseNodesFullCsv(text: string, now = nowStamp()): DbNode[] {
  return csvRows(text).map((r, i) => ({
    id: r.id ?? `csv-node-${i}`,
    parent_id: r.parent_id,
    name: r.name ?? "(unnamed)",
    depth: Math.max(0, Math.round(numOr(r.depth, 0))),
    sort_order: Math.round(numOr(r.sort_order, i)),
    est_effort: numOrNull(r.est_effort),
    pct_complete: Math.min(100, Math.max(0, numOr(r.pct_complete, 0))),
    deadline: r.deadline,
    planned_start: r.planned_start,
    status: r.status === "blocked" ? "blocked" : null,
    priority: parsePriority(r.priority),
    created_at: r.created_at ?? now,
    updated_at: r.updated_at ?? r.created_at ?? now,
    weight: numOr(r.weight, 1),
    rollup_mode: (ROLLUP_MODES as string[]).includes(String(r.rollup_mode).toLowerCase()) ? (String(r.rollup_mode).toLowerCase() as RollupMode) : null,
    unit: r.unit,
    hours_per_unit: numOrNull(r.hours_per_unit),
    weekly_target_hours: numOrNull(r.weekly_target_hours),
    color: r.color,
  }));
}

export function parseSessionsCsv(text: string, now = nowStamp()): Session[] {
  return csvRows(text).map((r, i) => {
    const started = r.started_at ?? now;
    return {
      id: r.id ?? `csv-session-${i}`,
      node_id: r.node_id,
      cycle_id: r.cycle_id,
      mode: oneOf(r.mode, ["single", "cycle"] as const, "single"),
      planned_seconds: Math.max(0, Math.round(numOr(r.planned_seconds, 0))),
      actual_seconds: Math.max(0, Math.round(numOr(r.actual_seconds, 0))),
      started_at: started,
      ended_at: r.ended_at ?? started,
      ended_reason: oneOf(r.ended_reason, ["completed", "aborted_credited", "aborted_discarded"] as const, "completed"),
      note: r.note,
      // A row that came in from a file is an imported row, whatever the file
      // called it — except that a genuine mirror export knows its own sources.
      source: oneOf(r.source, SESSION_SOURCES, "imported"),
      tz_offset: numOrNull(r.tz_offset),
    };
  });
}

export function parsePctHistoryCsv(text: string, now = nowStamp()): PctHistory[] {
  return csvRows(text)
    .filter((r) => r.node_id)
    .map((r, i) => ({
      id: r.id ?? `csv-pct-${i}`,
      node_id: r.node_id as string,
      pct: Math.min(100, Math.max(0, numOr(r.pct, 0))),
      changed_at: r.changed_at ?? now,
    }));
}

export function parseStatusHistoryCsv(text: string, now = nowStamp()): StatusHistory[] {
  return csvRows(text)
    .filter((r) => r.node_id)
    .map((r, i) => ({
      id: r.id ?? `csv-status-${i}`,
      node_id: r.node_id as string,
      status: r.status === "blocked" ? "blocked" : null,
      changed_at: r.changed_at ?? now,
      note: r.note,
    }));
}

export function parseChecklistCsv(text: string, now = nowStamp()): ChecklistItem[] {
  return csvRows(text)
    .filter((r) => r.node_id)
    .map((r, i) => ({
      id: r.id ?? `csv-check-${i}`,
      node_id: r.node_id as string,
      label: r.label ?? "",
      done: boolOf(r.done),
      sort_order: Math.round(numOr(r.sort_order, i)),
      created_at: r.created_at ?? now,
    }));
}

function nowStamp(): string {
  return new Date().toISOString();
}
