/**
 * Reading a `.db` file the user picked. The bytes are opened in a throwaway
 * sql.js connection, migrated forward if they came from an older release, and
 * copied out as a backup — so a database file and a JSON backup take exactly
 * the same route into the app.
 */
import { SqlJsDriver } from "./sqljs";
import { migrate } from "./migrations";
import { readAll } from "./repo";
import { buildBackup, type BackupFile } from "../lib/backup";

export async function backupFromDbBytes(bytes: Uint8Array): Promise<BackupFile> {
  const db = await SqlJsDriver.openBytes(bytes);
  try {
    // Doubles as the check that this really is a StudyTracker database:
    // migrate() refuses a file with foreign tables or a newer schema.
    const version = await migrate(db);
    return buildBackup(await readAll(db), version);
  } finally {
    await db.close().catch(() => {});
  }
}
