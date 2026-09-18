import { create } from "zustand";
import type { SqlDriver } from "../db/driver";
import { defaultStoragePath, openDatabase, rememberStoragePath, savedStoragePath } from "../db";
import { SqlJsDriver } from "../db/sqljs";
import * as repo from "../db/repo";
import type { ChecklistItem, DbNode, PctHistory, Session, Settings, SkinId } from "../types";
import { DEFAULT_SETTINGS, SUBJECT_COLORS } from "../types";
import { SKINS } from "../lib/skins";
import { computeRollup, rootTotals, type NodeRollup, type RootTotals } from "../lib/rollup";
import { writeMirror } from "../lib/mirror";
import { backupDatabase, dirname, isTauri } from "../platform";
import { buildWorkbook, workbookBytes } from "../lib/xlsx";
import { weeklySummary } from "../lib/stats";
import { saveBytes } from "../platform";
import type { ImportedNodeRow } from "../lib/csv";
import { uid, nowIso } from "../lib/ids";
import { isTreeSortKey, type TreeSortKey } from "../lib/treeSort";

export type View = "tree" | "timer" | "inbox" | "dashboard" | "settings";

export interface Toast {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
  ttl: number;
}

type UndoEntry = { label: string; run: () => Promise<void> };

const TREE_SORT_KEY = "studytracker.tree_sort";
function loadTreeSort(): TreeSortKey {
  try {
    const v = localStorage.getItem(TREE_SORT_KEY);
    return isTreeSortKey(v) ? v : "manual";
  } catch {
    return "manual";
  }
}

interface AppState {
  phase: "booting" | "pick-storage" | "ready" | "error";
  error: string | null;
  db: SqlDriver | null;
  dbPath: string;
  schemaVersion: number;

  nodes: DbNode[];
  sessions: Session[];
  history: PctHistory[];
  checklist: ChecklistItem[];
  /** done / total per node, for nodes that have a checklist */
  checklistStats: Map<string, { done: number; total: number }>;
  settings: Settings;
  rollup: Map<string, NodeRollup>;
  root: RootTotals;

  view: View;
  selectedNodeId: string | null;
  expanded: Set<string>;
  subjectFilter: string | null;
  /** tree ordering; every key but "manual" is applied per sibling group */
  treeSort: TreeSortKey;
  toasts: Toast[];
  undoStack: UndoEntry[];
  /** incremented to ask the tree to focus the percent editor of the selected row */
  editPctRequest: number;

  // lifecycle
  boot(): Promise<void>;
  chooseStorage(path: string): Promise<void>;
  reload(): Promise<void>;

  // navigation
  setView(v: View): void;
  select(id: string | null): void;
  toggleExpanded(id: string): void;
  expandAll(ids: string[]): void;
  setTreeSort(key: TreeSortKey): void;
  setSubjectFilter(id: string | null): void;
  requestEditPct(): void;

  // nodes
  addSubject(name?: string): Promise<DbNode>;
  addChild(parentId: string, name?: string): Promise<DbNode>;
  renameNode(id: string, name: string): Promise<void>;
  patchNode(id: string, patch: repo.NodePatch): Promise<void>;
  setPct(id: string, pct: number): Promise<void>;
  deleteNode(id: string): Promise<void>;
  duplicateNode(id: string): Promise<void>;
  moveNode(id: string, parentId: string | null, index: number): Promise<void>;

  // checklist (leaf tasks): items count equally and set the task's percent
  addChecklistItem(nodeId: string, label: string): Promise<void>;
  toggleChecklistItem(id: string): Promise<void>;
  renameChecklistItem(id: string, label: string): Promise<void>;
  deleteChecklistItem(id: string): Promise<void>;

  // sessions
  logSession(s: Omit<Session, "id">): Promise<Session>;
  assignSessions(ids: string[], nodeId: string | null): Promise<void>;
  updateSessionNote(id: string, note: string | null): Promise<void>;
  deleteSession(id: string): Promise<void>;

  // settings
  updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;

  // export/import
  exportXlsx(): Promise<string | null>;
  importNodes(rows: ImportedNodeRow[]): Promise<{ created: number; updated: number }>;

  // misc
  /** returns the toast id so the caller can dismiss it early */
  toast(message: string, action?: Toast["action"], ttl?: number): string;
  dismissToast(id: string): void;
  undo(): Promise<void>;
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let backupTimer: ReturnType<typeof setInterval> | null = null;

export const useApp = create<AppState>((set, get) => {
  const requireDb = (): SqlDriver => {
    const db = get().db;
    if (!db) throw new Error("Database not ready");
    return db;
  };

  const afterWrite = async () => {
    await get().reload();
    const { settings, dbPath, nodes, sessions, history, checklist } = get();
    if (settings.csv_mirror && isTauri() && dbPath) {
      if (mirrorTimer) clearTimeout(mirrorTimer);
      mirrorTimer = setTimeout(() => {
        writeMirror(dirname(dbPath), { nodes, sessions, history, checklist, rollupMode: settings.rollup_mode }).catch((e) => console.error("csv mirror failed", e));
      }, 300);
    }
  };

  const pushUndo = (entry: UndoEntry) => {
    const stack = [...get().undoStack, entry].slice(-20);
    set({ undoStack: stack });
  };

  return {
    phase: "booting",
    error: null,
    db: null,
    dbPath: "",
    schemaVersion: 0,
    nodes: [],
    sessions: [],
    history: [],
    checklist: [],
    checklistStats: new Map(),
    settings: DEFAULT_SETTINGS,
    rollup: new Map(),
    root: { pct: 0, estHours: null, remainingHours: null, subjectCount: 0 },
    view: "tree",
    selectedNodeId: null,
    expanded: new Set(),
    subjectFilter: null,
    treeSort: loadTreeSort(),
    toasts: [],
    undoStack: [],
    editPctRequest: 0,

    async boot() {
      try {
        if (isTauri()) {
          const saved = savedStoragePath();
          if (!saved) {
            set({ phase: "pick-storage" });
            return;
          }
          await get().chooseStorage(saved);
        } else {
          await get().chooseStorage("");
        }
      } catch (e) {
        set({ phase: "error", error: String(e) });
      }
    },

    async chooseStorage(path: string) {
      try {
        const target = path || (isTauri() ? await defaultStoragePath() : "");
        const opened = await openDatabase(target);
        if (isTauri()) rememberStoragePath(target);
        // Switching folders in one page life: drop the old handle and its backup timer.
        const previous = get().db;
        if (previous && previous !== opened.db) await previous.close().catch(() => {});
        if (backupTimer) clearInterval(backupTimer);
        backupTimer = null;
        if (opened.db instanceof SqlJsDriver) {
          opened.db.onPersistError = (e) => get().toast(`Could not save to browser storage: ${e instanceof Error ? e.message : String(e)}`, undefined, 10000);
        }
        set({ db: opened.db, dbPath: opened.path, schemaVersion: opened.schemaVersion });
        await repo.saveSetting(opened.db, "storage_path", opened.path);
        await get().reload();
        // expand subjects by default
        set((s) => ({ expanded: new Set(s.nodes.filter((n) => n.parent_id === null).map((n) => n.id)), phase: "ready" }));
        applyTheme(get().settings.theme, get().settings.skin);
        // Daily backup, keep 7. Re-check hourly for long-running sessions.
        const runBackup = () =>
          backupDatabase(opened.path, 7)
            .then((p) => p && console.info("backup written", p))
            .catch((e) => console.warn("backup failed", e));
        if (isTauri()) {
          runBackup();
          backupTimer = setInterval(runBackup, 60 * 60 * 1000);
        }
      } catch (e) {
        set({ phase: "error", error: String(e) });
      }
    },

    async reload() {
      const db = requireDb();
      const [nodes, sessions, history, settings, checklist] = await Promise.all([
        repo.listNodes(db),
        repo.listSessions(db),
        repo.listPctHistory(db),
        repo.loadSettings(db),
        repo.listChecklist(db),
      ]);
      const rollup = computeRollup(nodes, settings.rollup_mode);
      const checklistStats = new Map<string, { done: number; total: number }>();
      for (const it of checklist) {
        const s = checklistStats.get(it.node_id) ?? { done: 0, total: 0 };
        s.total++;
        if (it.done) s.done++;
        checklistStats.set(it.node_id, s);
      }
      set({ nodes, sessions, history, checklist, checklistStats, settings, rollup, root: rootTotals(nodes, rollup) });
      applyTheme(settings.theme, settings.skin);
    },

    setView: (view) => set({ view }),
    select: (selectedNodeId) => set({ selectedNodeId }),
    toggleExpanded(id) {
      set((s) => {
        const e = new Set(s.expanded);
        if (e.has(id)) e.delete(id);
        else e.add(id);
        return { expanded: e };
      });
    },
    expandAll(ids) {
      set((s) => ({ expanded: new Set([...s.expanded, ...ids]) }));
    },
    setSubjectFilter: (subjectFilter) => set({ subjectFilter }),
    setTreeSort(treeSort) {
      set({ treeSort });
      try {
        localStorage.setItem(TREE_SORT_KEY, treeSort);
      } catch {
        /* private mode or blocked storage: keep it for this session only */
      }
    },
    requestEditPct: () => set((s) => ({ editPctRequest: s.editPctRequest + 1 })),

    async addSubject(name = "New project") {
      const db = requireDb();
      const count = get().nodes.filter((n) => n.parent_id === null).length;
      const node = await repo.createNode(db, {
        parent_id: null,
        name,
        unit: "hours",
        color: SUBJECT_COLORS[count % SUBJECT_COLORS.length],
      });
      await afterWrite();
      set((s) => ({ selectedNodeId: node.id, expanded: new Set([...s.expanded, node.id]) }));
      return node;
    },

    async addChild(parentId, name = "New task") {
      const db = requireDb();
      const node = await repo.createNode(db, { parent_id: parentId, name, est_effort: 1 });
      await afterWrite();
      set((s) => ({ selectedNodeId: node.id, expanded: new Set([...s.expanded, parentId]) }));
      return node;
    },

    async renameNode(id, name) {
      await repo.updateNode(requireDb(), id, { name });
      await afterWrite();
    },

    async patchNode(id, patch) {
      await repo.updateNode(requireDb(), id, patch);
      await afterWrite();
    },

    async setPct(id, pct) {
      const db = requireDb();
      const before = get().nodes.find((n) => n.id === id)?.pct_complete ?? 0;
      if (before === pct) return;
      await repo.setPct(db, id, pct);
      pushUndo({
        label: "percent change",
        run: async () => {
          await repo.setPct(db, id, before);
          await afterWrite();
        },
      });
      await afterWrite();
    },

    async deleteNode(id) {
      const db = requireDb();
      const snap = await repo.snapshotSubtree(db, id);
      const sessionMap: Record<string, string> = {};
      for (const s of get().sessions) if (s.node_id && snap.nodes.some((n) => n.id === s.node_id)) sessionMap[s.id] = s.node_id;
      await repo.deleteNode(db, id);
      const name = snap.nodes.find((n) => n.id === id)?.name ?? "node";
      let restored = false;
      const restore = async () => {
        // reachable from both the toast button and ⌘Z; a second run would
        // INSERT OR REPLACE the subtree and cascade-delete edits made since
        if (restored) return;
        restored = true;
        await repo.restoreSubtree(db, snap, sessionMap);
        await afterWrite();
      };
      pushUndo({ label: `delete ${name}`, run: restore });
      if (get().selectedNodeId && snap.nodes.some((n) => n.id === get().selectedNodeId)) set({ selectedNodeId: null });
      await afterWrite();
      get().toast(`Deleted "${name}"`, {
        label: "Undo",
        run: () => {
          restore().catch((e) => get().toast(`Undo failed: ${e}`));
        },
      });
    },

    async duplicateNode(id) {
      const newId = await repo.duplicateNode(requireDb(), id);
      await afterWrite();
      set({ selectedNodeId: newId });
    },

    async moveNode(id, parentId, index) {
      try {
        await repo.moveNode(requireDb(), id, parentId, index);
        await afterWrite();
        if (parentId) set((s) => ({ expanded: new Set([...s.expanded, parentId]) }));
      } catch (e) {
        get().toast(String(e instanceof Error ? e.message : e));
      }
    },

    async addChecklistItem(nodeId, label) {
      const db = requireDb();
      const text = label.trim();
      if (!text) return;
      await repo.addChecklistItem(db, nodeId, text);
      await repo.syncChecklistPct(db, nodeId);
      await afterWrite();
    },

    async toggleChecklistItem(id) {
      const db = requireDb();
      const it = get().checklist.find((x) => x.id === id);
      if (!it) return;
      await repo.updateChecklistItem(db, id, { done: !it.done });
      await repo.syncChecklistPct(db, it.node_id);
      await afterWrite();
    },

    async renameChecklistItem(id, label) {
      const text = label.trim();
      if (!text) return;
      await repo.updateChecklistItem(requireDb(), id, { label: text });
      await afterWrite();
    },

    async deleteChecklistItem(id) {
      const db = requireDb();
      const it = get().checklist.find((x) => x.id === id);
      if (!it) return;
      await repo.deleteChecklistItem(db, id);
      await repo.syncChecklistPct(db, it.node_id);
      pushUndo({
        label: "delete checklist item",
        run: async () => {
          await repo.restoreChecklistItem(db, it);
          await repo.syncChecklistPct(db, it.node_id);
          await afterWrite();
        },
      });
      await afterWrite();
    },

    async logSession(s) {
      const full = await repo.insertSession(requireDb(), s);
      await afterWrite();
      return full;
    },

    async assignSessions(ids, nodeId) {
      await repo.assignSessions(requireDb(), ids, nodeId);
      await afterWrite();
    },

    async updateSessionNote(id, note) {
      await repo.updateSessionNote(requireDb(), id, note);
      await afterWrite();
    },

    async deleteSession(id) {
      const db = requireDb();
      const s = get().sessions.find((x) => x.id === id);
      await repo.deleteSession(db, id);
      if (s) {
        pushUndo({
          label: "delete session",
          run: async () => {
            await repo.insertSession(db, s);
            await afterWrite();
          },
        });
      }
      await afterWrite();
    },

    async updateSetting(key, value) {
      await repo.saveSetting(requireDb(), key, value);
      await afterWrite();
    },

    async exportXlsx() {
      const { nodes, sessions, history, settings, checklist } = get();
      const wb = buildWorkbook(nodes, sessions, history, weeklySummary(nodes, sessions, history, new Date(), settings.rollup_mode), checklist);
      const bytes = workbookBytes(wb);
      const name = `studytracker-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return saveBytes(name, bytes, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    },

    async importNodes(rows) {
      const db = requireDb();
      const existing = new Map(get().nodes.map((n) => [n.id, n]));
      // Local view of depth / next sort_order so no selects are needed inside the transaction.
      const depthOf = new Map<string, number>(get().nodes.map((n) => [n.id, n.depth]));
      const nextSort = new Map<string | null, number>();
      for (const n of get().nodes) nextSort.set(n.parent_id, Math.max(nextSort.get(n.parent_id) ?? 0, n.sort_order + 1));
      let created = 0,
        updated = 0;
      const pending = [...rows];
      const known = new Set(existing.keys());
      // Order rows so parents come before children.
      const ordered: typeof rows = [];
      let progress = true;
      while (pending.length && progress) {
        progress = false;
        for (let i = 0; i < pending.length; i++) {
          const r = pending[i];
          if (r.parent_id && !known.has(r.parent_id)) continue;
          pending.splice(i, 1);
          i--;
          progress = true;
          if (!r.id || !existing.has(r.id)) {
            if (!r.id) r.id = uid();
          }
          known.add(r.id);
          ordered.push(r);
        }
      }
      if (pending.length) throw new Error(`${pending.length} row(s) reference a parent_id that does not exist`);

      await db.transaction(async (tx) => {
        for (const r of ordered) {
          const id = r.id!;
          const isSubject = !r.parent_id;
          const ts = nowIso();
          if (r.pct_complete !== null) r.pct_complete = repo.clampPct(r.pct_complete);
          if (existing.has(id)) {
            const sets: string[] = ["name = ?", "updated_at = ?"];
            const vals: unknown[] = [r.name, ts];
            if (r.est_effort !== null) {
              sets.push("est_effort = ?");
              vals.push(r.est_effort);
            }
            if (r.deadline !== null) {
              sets.push("deadline = ?");
              vals.push(r.deadline);
            }
            if (r.weight !== null) {
              sets.push("weight = ?");
              vals.push(r.weight);
            }
            if (r.rollup_mode !== null) {
              sets.push("rollup_mode = ?");
              vals.push(r.rollup_mode);
            }
            if (isSubject) {
              for (const k of ["unit", "hours_per_unit", "weekly_target_hours", "color"] as const) {
                if (r[k] !== null) {
                  sets.push(`${k} = ?`);
                  vals.push(r[k]);
                }
              }
            }
            await tx.execute(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
            if (r.pct_complete !== null && r.pct_complete !== existing.get(id)!.pct_complete) {
              await tx.execute("UPDATE nodes SET pct_complete = ? WHERE id = ?", [r.pct_complete, id]);
              await tx.execute("INSERT INTO pct_history (id,node_id,pct,changed_at) VALUES (?,?,?,?)", [uid(), id, r.pct_complete, ts]);
            }
            updated++;
          } else {
            const depth = r.parent_id ? (depthOf.get(r.parent_id) ?? 0) + 1 : 0;
            depthOf.set(id, depth);
            const sort = r.sort_order ?? nextSort.get(r.parent_id) ?? 0;
            nextSort.set(r.parent_id, Math.max(nextSort.get(r.parent_id) ?? 0, sort + 1));
            await tx.execute(
              repo.NODE_INSERT_SQL,
              repo.nodeValues({
                id,
                parent_id: r.parent_id,
                name: r.name,
                depth,
                sort_order: sort,
                est_effort: r.est_effort,
                pct_complete: r.pct_complete ?? 0,
                deadline: r.deadline,
                created_at: ts,
                updated_at: ts,
                weight: r.weight ?? 1,
                rollup_mode: r.rollup_mode,
                unit: isSubject ? (r.unit ?? "hours") : null,
                hours_per_unit: isSubject ? r.hours_per_unit : null,
                weekly_target_hours: isSubject ? r.weekly_target_hours : null,
                color: isSubject ? (r.color ?? SUBJECT_COLORS[created % SUBJECT_COLORS.length]) : null,
              }),
            );
            if (r.pct_complete) {
              await tx.execute("INSERT INTO pct_history (id,node_id,pct,changed_at) VALUES (?,?,?,?)", [uid(), id, r.pct_complete, ts]);
            }
            created++;
          }
        }
      });
      await afterWrite();
      return { created, updated };
    },

    toast(message, action, ttl = 6000) {
      const id = uid();
      set((s) => ({ toasts: [...s.toasts, { id, message, action, ttl }] }));
      setTimeout(() => get().dismissToast(id), ttl);
      return id;
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    async undo() {
      const stack = get().undoStack;
      const last = stack[stack.length - 1];
      if (!last) {
        get().toast("Nothing to undo");
        return;
      }
      set({ undoStack: stack.slice(0, -1) });
      try {
        await last.run();
        get().toast(`Undid ${last.label}`);
      } catch (e) {
        get().toast(`Undo failed: ${e}`);
      }
    },
  };
});

if (typeof window !== "undefined") {
  // Debounced IndexedDB writes could be lost when the tab closes right after an edit.
  window.addEventListener("pagehide", () => {
    const db = useApp.getState().db;
    if (db instanceof SqlJsDriver) db.flush().catch(() => {});
  });
}

/* --------------------------------------------------------------- theme */

let mediaBound = false;
/**
 * Apply colour theme and skin to <html>. The skin is a data attribute so all
 * of its styling lives in CSS. Unknown skin ids (e.g. one that was removed)
 * fall back to the first skin.
 */
export function applyTheme(theme: Settings["theme"], skin: SkinId = "clean") {
  const root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const def = SKINS.find((s) => s.id === skin) ?? SKINS[0];
  const dark = theme === "dark" || (theme === "system" && mq.matches);
  root.classList.toggle("dark", dark);
  root.dataset.skin = def.id;
  if (!mediaBound) {
    mediaBound = true;
    mq.addEventListener("change", () => {
      const s = useApp.getState().settings;
      applyTheme(s.theme, s.skin);
    });
  }
}
