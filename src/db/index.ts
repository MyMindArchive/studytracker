import type { SqlDriver } from "./driver";
import { isTauri } from "./driver";
import { migrate } from "./migrations";
import { ensureDir, dirname, homeDir, joinPath, STORAGE_PATH_KEY } from "../platform";

export const DB_FILENAME = "studytracker.db";

export function savedStoragePath(): string | null {
  try {
    return localStorage.getItem(STORAGE_PATH_KEY);
  } catch {
    return null;
  }
}

export function rememberStoragePath(path: string): void {
  try {
    localStorage.setItem(STORAGE_PATH_KEY, path);
  } catch {
    /* ignore */
  }
}

export async function defaultStoragePath(): Promise<string> {
  const home = await homeDir();
  return joinPath(home, "StudyTracker", DB_FILENAME);
}

export interface OpenedDb {
  db: SqlDriver;
  path: string; // absolute db path (Tauri) or "" in browser
  schemaVersion: number;
}

export async function openDatabase(path: string): Promise<OpenedDb> {
  let db: SqlDriver;
  if (isTauri()) {
    await ensureDir(dirname(path));
    const { TauriSqlDriver } = await import("./tauri");
    db = await TauriSqlDriver.open(path);
  } else {
    const { SqlJsDriver } = await import("./sqljs");
    db = await SqlJsDriver.openPersistent();
    await db.execute("PRAGMA foreign_keys = ON");
  }
  const schemaVersion = await migrate(db);
  return { db, path: isTauri() ? path : "", schemaVersion };
}
