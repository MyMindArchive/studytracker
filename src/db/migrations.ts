import type { SqlDriver } from "./driver";

interface Migration {
  version: number;
  statements: string[];
}

/**
 * Schema is versioned with PRAGMA user_version. Add a new entry for every
 * change; never edit an existing one once shipped.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        est_effort REAL NULL,
        pct_complete REAL NOT NULL DEFAULT 0 CHECK (pct_complete >= 0 AND pct_complete <= 100),
        deadline TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        unit TEXT NULL,
        hours_per_unit REAL NULL,
        weekly_target_hours REAL NULL,
        color TEXT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort_order)`,
      `CREATE TABLE IF NOT EXISTS pct_history (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        pct REAL NOT NULL,
        changed_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pct_history_node ON pct_history(node_id, changed_at)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        node_id TEXT NULL REFERENCES nodes(id) ON DELETE SET NULL,
        cycle_id TEXT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('single','cycle')),
        planned_seconds INTEGER NOT NULL,
        actual_seconds INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        ended_reason TEXT NOT NULL CHECK (ended_reason IN ('completed','aborted_credited','aborted_discarded')),
        note TEXT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id)`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      // Per-child share used by the "weight" roll-up rule; 1 = same as its siblings.
      `ALTER TABLE nodes ADD COLUMN weight REAL NOT NULL DEFAULT 1`,
      // Roll-up rule for a node's children ('equal' | 'weight' | 'effort'); NULL inherits.
      `ALTER TABLE nodes ADD COLUMN rollup_mode TEXT NULL`,
    ],
  },
  {
    version: 3,
    statements: [
      // Tick boxes under a leaf task; checking them sets the task's percent (equal weight per item).
      `CREATE TABLE IF NOT EXISTS checklist_items (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_checklist_node ON checklist_items(node_id, sort_order)`,
    ],
  },
  {
    version: 4,
    statements: [
      // Where a session came from. Existing rows predate the column, so they
      // get 'unknown' rather than a guess: the app has had manual logging for
      // a while and there is no honest way to tell those rows apart now.
      `ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'`,
      // Minutes east of UTC at the moment it was recorded. Timestamps are
      // stored UTC, but "which hour do I study best" is a local-time question,
      // and reading it off the current zone re-dates all of history after a move.
      `ALTER TABLE sessions ADD COLUMN tz_offset INTEGER NULL`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`,
      // The day work was meant to start (deadline's counterpart).
      `ALTER TABLE nodes ADD COLUMN planned_start TEXT NULL`,
      // NULL = status is whatever the percent says; 'blocked' = waiting on
      // something. Kept as an override rather than a parallel state machine so
      // the percent stays the single source of truth for progress.
      `ALTER TABLE nodes ADD COLUMN status TEXT NULL`,
      `CREATE TABLE IF NOT EXISTS status_history (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        status TEXT NULL,
        changed_at TEXT NOT NULL,
        note TEXT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_status_history_node ON status_history(node_id, changed_at)`,
    ],
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Sanity check that the file is a StudyTracker database (or brand new). */
async function assertKnownDatabase(db: SqlDriver, version: number): Promise<void> {
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `This database was created by a newer StudyTracker (schema v${version}, this app knows v${CURRENT_SCHEMA_VERSION}). Update the app or pick another folder.`,
    );
  }
  if (version === 0) {
    // A foreign SQLite file with user_version 0 would silently get our tables
    // bolted on; refuse if it already has tables we do not know about.
    const tables = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    const known = new Set(["nodes", "pct_history", "sessions", "settings", "checklist_items", "status_history"]);
    const foreign = tables.map((t) => t.name).filter((n) => !known.has(n));
    if (foreign.length) throw new Error(`This file is not a StudyTracker database (contains tables: ${foreign.join(", ")}).`);
  }
}

export async function migrate(db: SqlDriver): Promise<number> {
  const rows = await db.select<{ user_version: number }>("PRAGMA user_version");
  let version = Number(rows[0]?.user_version ?? 0);
  await assertKnownDatabase(db, version);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    // The version bump is part of the same transaction: a crash between the
    // DDL and the PRAGMA would otherwise replay ALTER TABLE on the next start
    // and fail with "duplicate column".
    await db.transaction(async (tx) => {
      for (const s of m.statements) await tx.execute(s);
      await tx.execute(`PRAGMA user_version = ${m.version}`);
    });
    version = m.version;
  }
  return version;
}
