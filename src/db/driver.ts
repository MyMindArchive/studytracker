export interface ExecResult {
  rowsAffected: number;
  lastInsertId?: number;
}

/** Minimal SQL driver shared by the Tauri SQL plugin and the sql.js fallback. */
export interface SqlDriver {
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<ExecResult>;
  /** Run several statements atomically. */
  transaction(fn: (tx: SqlDriver) => Promise<void>): Promise<void>;
  close(): Promise<void>;
  /** Human readable description of where data lives (path or "browser"). */
  readonly location: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
