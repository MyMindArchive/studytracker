/** Coerce JS values into what SQLite bindings accept (shared by both drivers). */
export function normalizeParam(p: unknown): unknown {
  if (p === undefined) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  if (typeof p === "number" && !Number.isFinite(p)) return null;
  if (p instanceof Date) return p.toISOString();
  return p;
}
