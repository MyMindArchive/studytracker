import type { SqlDriver, ExecResult } from "./driver";
import type { Database, SqlJsStatic } from "sql.js";
import { normalizeParam } from "./params";

const IDB_NAME = "studytracker";
const IDB_STORE = "db";
const IDB_KEY = "main";

async function loadSqlJs(): Promise<SqlJsStatic> {
  const mod = (await import("sql.js")) as unknown as Record<string, unknown>;
  // sql.js ships UMD; depending on the bundler the factory is the module
  // itself, `default`, or `default.default`.
  const candidates = [mod, mod.default, (mod.default as Record<string, unknown> | undefined)?.default];
  const initSqlJs = candidates.find((c) => typeof c === "function") as ((cfg?: object) => Promise<SqlJsStatic>) | undefined;
  if (!initSqlJs) throw new Error("sql.js failed to load");
  if (typeof window !== "undefined") {
    const wasmUrl = (await import("sql.js/dist/sql-wasm.wasm?url")).default;
    return initSqlJs({ locateFile: () => wasmUrl });
  }
  return initSqlJs();
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbLoad(): Promise<Uint8Array | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSave(bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await idbOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export class SqlJsDriver implements SqlDriver {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private inTx = false;
  private txQueue: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  /** Called when the debounced IndexedDB write fails (quota, private mode…). */
  onPersistError: ((e: unknown) => void) | null = null;
  readonly location: string;

  private constructor(
    private db: Database,
    private persist: boolean,
  ) {
    this.location = persist ? "Browser storage (IndexedDB)" : "In-memory";
  }

  /** Persistent browser database (IndexedDB backed). */
  static async openPersistent(): Promise<SqlJsDriver> {
    const SQL = await loadSqlJs();
    const existing = await idbLoad();
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    return new SqlJsDriver(db, true);
  }

  /**
   * Read-only-ish view of a database file the user handed us (a restore).
   * It is never persisted: the bytes are inspected, copied out, and dropped.
   */
  static async openBytes(bytes: Uint8Array): Promise<SqlJsDriver> {
    const SQL = await loadSqlJs();
    let db: Database;
    try {
      db = new SQL.Database(bytes);
      db.run("PRAGMA foreign_keys = ON");
    } catch {
      throw new Error("That file is not a SQLite database.");
    }
    return new SqlJsDriver(db, false);
  }

  /** Throwaway in-memory database (tests). */
  static async openMemory(): Promise<SqlJsDriver> {
    const SQL = await loadSqlJs();
    return new SqlJsDriver(new SQL.Database(), false);
  }

  private runSelect<T>(sql: string, params: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params.map(normalizeParam) as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  private runExecute(sql: string, params: unknown[]): ExecResult {
    this.db.run(sql, params.map(normalizeParam) as never);
    const rowsAffected = this.db.getRowsModified();
    const [{ id }] = this.runSelect<{ id: number }>("SELECT last_insert_rowid() AS id", []);
    this.dirty = true;
    this.scheduleSave();
    return { rowsAffected, lastInsertId: id };
  }

  async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.runSelect<T>(sql, params);
  }

  /**
   * A write issued while a transaction is open on this single connection
   * would silently become part of it (and be lost if it rolls back), so it
   * waits for the transaction to finish. Statements *inside* a transaction
   * must go through the `tx` handle passed to the callback, not `db`.
   */
  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    while (this.inTx) await this.txQueue;
    return this.runExecute(sql, params);
  }

  /** Transactions are serialised: `fn` awaits between statements, so two
   *  overlapping calls would otherwise both issue BEGIN on the one connection. */
  async transaction(fn: (tx: SqlDriver) => Promise<void>): Promise<void> {
    const tx: SqlDriver = {
      location: this.location,
      select: async (sql, params = []) => this.runSelect(sql, params),
      execute: async (sql, params = []) => this.runExecute(sql, params),
      // nested transaction inside the callback: same transaction, no new BEGIN
      transaction: async (inner) => inner(tx),
      close: async () => {},
    };
    const run = async () => {
      this.db.run("BEGIN");
      this.inTx = true;
      try {
        await fn(tx);
        this.db.run("COMMIT");
      } catch (e) {
        this.db.run("ROLLBACK");
        throw e;
      } finally {
        this.inTx = false;
      }
      this.dirty = true;
      this.scheduleSave();
    };
    const next = this.txQueue.then(run, run);
    this.txQueue = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  /**
   * Raw bytes of the database. sql.js closes and reopens the connection on
   * export, which drops per-connection PRAGMAs, so foreign keys are re-enabled.
   * Never call while a transaction is open: the reopen would discard it.
   */
  exportBytes(): Uint8Array {
    if (this.inTx) throw new Error("cannot export while a transaction is open");
    const bytes = this.db.export();
    this.db.run("PRAGMA foreign_keys = ON");
    return bytes;
  }

  /** Write pending changes to IndexedDB now. */
  async flush(): Promise<void> {
    if (!this.persist) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    while (this.inTx) await this.txQueue;
    await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    await idbSave(this.exportBytes());
  }

  private scheduleSave() {
    if (!this.persist) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.inTx) {
        this.scheduleSave();
        return;
      }
      if (!this.dirty) return;
      this.dirty = false;
      const bytes = this.exportBytes();
      // saves are chained so an older snapshot can never overwrite a newer one
      this.saving = this.saving
        .then(() => idbSave(bytes))
        .catch((e) => {
          this.dirty = true;
          console.error("persist failed", e);
          this.onPersistError?.(e);
        });
    }, 250);
  }
}
