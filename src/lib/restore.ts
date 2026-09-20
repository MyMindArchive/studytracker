/**
 * Turning whatever the user picked into something restorable. Anything the
 * app has ever handed out is accepted — the JSON backup, the SQLite database,
 * or the CSV mirror — because "I still have the files I downloaded" should be
 * enough to get the data back, whichever button produced them.
 */
import { backupFromDbBytes } from "../db/dbfile";
import { backupFromCsv, parseBackup, type BackupFile } from "./backup";

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

const SQLITE_MAGIC = "SQLite format 3\0";

export function isSqliteBytes(b: Uint8Array): boolean {
  if (b.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) if (b[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

function decode(b: Uint8Array): string {
  return new TextDecoder("utf-8").decode(b);
}

export async function backupFromFiles(files: PickedFile[], schemaVersion: number, now = new Date()): Promise<BackupFile> {
  if (!files.length) throw new Error("No file picked.");

  // Read by content rather than by extension: a file renamed on the way
  // through a phone or a chat app still restores.
  const sqlite = files.find((f) => isSqliteBytes(f.bytes));
  if (sqlite) return backupFromDbBytes(sqlite.bytes);

  const texts = files.map((f) => ({ name: f.name, text: decode(f.bytes) }));
  const json = texts.find((f) => f.text.trimStart().startsWith("{"));
  if (json) return parseBackup(json.text);

  return backupFromCsv(texts, schemaVersion, now);
}
