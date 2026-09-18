import type { SqlDriver, ExecResult } from "./driver";
import Database from "@tauri-apps/plugin-sql";
import { normalizeParam } from "./params";

/**
 * Driver over the Tauri SQL plugin. Single statements go through the plugin's
 * pooled connection; multi-statement writes go through the Rust `sql_batch`
 * command so they run in one real transaction (see `transaction`).
 */

export class TauriSqlDriver implements SqlDriver {
  readonly location: string;
  private constructor(
    private db: Database,
    path: string,
  ) {
    this.location = path;
  }

  static async open(path: string): Promise<TauriSqlDriver> {
    const db = await Database.load(`sqlite:${path}`);
    // journal_mode is persistent in the file; foreign_keys is per connection
    // but sqlx enables it by default on every pooled connection as well.
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA foreign_keys = ON");
    return new TauriSqlDriver(db, path);
  }

  select<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(sql, params.map(normalizeParam));
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const r = await this.db.execute(sql, params.map(normalizeParam));
    return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId };
  }

  /**
   * Statements issued inside `fn` are recorded and sent to the `sql_batch`
   * command, which runs them in one transaction on a single connection. The
   * plugin's pooled `execute` cannot do that: BEGIN and COMMIT may land on
   * different connections and leave a write lock open. Selects are not
   * available inside a transaction; compute what you need beforehand.
   */
  async transaction(fn: (tx: SqlDriver) => Promise<void>): Promise<void> {
    const statements: { sql: string; params: unknown[] }[] = [];
    const recorder: SqlDriver = {
      location: this.location,
      select: async () => {
        throw new Error("select() is not available inside a transaction");
      },
      execute: async (sql, params = []) => {
        statements.push({ sql, params: params.map(normalizeParam) });
        return { rowsAffected: 0 };
      },
      transaction: async (inner) => inner(recorder),
      close: async () => {},
    };
    await fn(recorder);
    if (statements.length === 0) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<number>("sql_batch", { dbPath: this.location, statements });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
