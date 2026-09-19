import type { ChecklistItem, DbNode, PctHistory, RollupMode, Session, StatusHistory } from "../types";
import { checklistCsv, nodesCsv, pctHistoryCsv, sessionsCsv, statusHistoryCsv, weeklySummaryCsv } from "./csv";
import { weeklySummary } from "./stats";
import { isTauri, joinPath, writeText } from "../platform";

export interface MirrorData {
  nodes: DbNode[];
  sessions: Session[];
  history: PctHistory[];
  checklist?: ChecklistItem[];
  statusHistory?: StatusHistory[];
  /** default roll-up rule, so weekly_summary.csv matches what the app shows */
  rollupMode?: RollupMode;
}

export function mirrorFiles(data: MirrorData, now = new Date()): Record<string, string> {
  return {
    "nodes.csv": nodesCsv(data.nodes),
    "sessions.csv": sessionsCsv(data.sessions),
    "pct_history.csv": pctHistoryCsv(data.history),
    "checklist.csv": checklistCsv(data.checklist ?? []),
    "status_history.csv": statusHistoryCsv(data.statusHistory ?? []),
    "weekly_summary.csv": weeklySummaryCsv(weeklySummary(data.nodes, data.sessions, data.history, now, data.rollupMode)),
  };
}

/** Regenerate the CSV mirrors in the storage folder. No-op outside Tauri. */
export async function writeMirror(storageDir: string, data: MirrorData): Promise<void> {
  if (!isTauri() || !storageDir) return;
  const files = mirrorFiles(data);
  await Promise.all(Object.entries(files).map(([name, text]) => writeText(joinPath(storageDir, name), text)));
}
