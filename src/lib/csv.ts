import type { ChecklistItem, DbNode, PctHistory, RollupMode, Session, StatusHistory } from "../types";
import { ROLLUP_MODES } from "../types";
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

export function nodesCsv(nodes: DbNode[]): string {
  return toCsv(nodes as unknown as Record<string, unknown>[], NODE_COLUMNS);
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
    weight: num(get(r, "weight")),
    rollup_mode: mode(get(r, "rollup_mode")),
    unit: get(r, "unit"),
    hours_per_unit: num(get(r, "hours_per_unit")),
    weekly_target_hours: num(get(r, "weekly_target_hours")),
    color: get(r, "color"),
    sort_order: num(get(r, "sort_order")),
  }));
}
