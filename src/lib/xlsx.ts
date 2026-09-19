import * as XLSX from "xlsx";
import type { ChecklistItem, DbNode, PctHistory, Session, StatusHistory } from "../types";
import { CHECKLIST_COLUMNS, NODE_COLUMNS, PCT_COLUMNS, SESSION_COLUMNS, STATUS_COLUMNS, WEEKLY_COLUMNS } from "./csv";
import type { WeeklySummaryRow } from "./stats";

function sheetFrom<T extends Record<string, unknown>>(rows: T[], columns: (keyof T & string)[]): XLSX.WorkSheet {
  const data = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of columns) o[c] = r[c] ?? null;
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: columns });
  // Freeze header row
  ws["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" } as never;
  // Autofit column widths (bounded)
  ws["!cols"] = columns.map((c) => {
    let w = c.length;
    for (const r of data) {
      const v = r[c];
      const len = v === null || v === undefined ? 0 : String(v).length;
      if (len > w) w = len;
    }
    return { wch: Math.min(60, Math.max(8, w + 2)) };
  });
  return ws;
}

export function buildWorkbook(
  nodes: DbNode[],
  sessions: Session[],
  history: PctHistory[],
  weekly: WeeklySummaryRow[],
  checklist: ChecklistItem[] = [],
  statusHistory: StatusHistory[] = [],
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(nodes as unknown as Record<string, unknown>[], NODE_COLUMNS), "Nodes");
  XLSX.utils.book_append_sheet(wb, sheetFrom(sessions as unknown as Record<string, unknown>[], SESSION_COLUMNS), "Sessions");
  XLSX.utils.book_append_sheet(wb, sheetFrom(history as unknown as Record<string, unknown>[], PCT_COLUMNS), "PctHistory");
  XLSX.utils.book_append_sheet(wb, sheetFrom(weekly as unknown as Record<string, unknown>[], WEEKLY_COLUMNS), "WeeklySummary");
  XLSX.utils.book_append_sheet(wb, sheetFrom(checklist.map((i) => ({ ...i, done: i.done ? 1 : 0 })) as unknown as Record<string, unknown>[], CHECKLIST_COLUMNS), "Checklist");
  XLSX.utils.book_append_sheet(wb, sheetFrom(statusHistory as unknown as Record<string, unknown>[], STATUS_COLUMNS), "StatusHistory");
  return wb;
}

export function workbookBytes(wb: XLSX.WorkBook): Uint8Array {
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}
