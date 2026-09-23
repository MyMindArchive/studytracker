import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Plus, ChevronsDownUp, ChevronsUpDown, ArrowUpDown, X } from "lucide-react";
import { startOfDay } from "date-fns";
import { useApp } from "../../store/app";
import { childrenOf } from "../../lib/rollup";
import type { DbNode } from "../../types";
import { TreeRow } from "./TreeRow";
import { NodeDetail } from "./NodeDetail";
import { Modal } from "../ui/Modal";
import { fmtHours } from "../../lib/time";
import { creditedSessions } from "../../lib/stats";
import { ROLLUP_LABEL } from "../../lib/rollup";
import { effectiveDeadlines, effectivePriorities, sortSiblings, TREE_SORT_OPTIONS, type EffectiveDeadline, type EffectivePriority } from "../../lib/treeSort";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";

export interface FlatRow {
  node: DbNode;
  hasChildren: boolean;
  expanded: boolean;
}

/* ------------------------------------------------------------ column widths */

type ColKey = "pct" | "est" | "weight" | "due";
type ColWidths = Record<ColKey, number>;

const COL_DEFAULT: ColWidths = { pct: 56, est: 76, weight: 56, due: 84 };
const COL_MIN: ColWidths = { pct: 48, est: 64, weight: 48, due: 64 };
const COL_MAX = 480;
const NAME_MIN = 160;
const PROGRESS_MIN = 100;
const PROGRESS_MAX = 180;
const COLS_KEY = "studytracker.tree_cols";
const DETAIL_KEY = "studytracker.tree_detail_w";
const DETAIL_DEFAULT = 340;
const DETAIL_MIN = 280;
const DETAIL_MAX = 640;
/** Below this the tree and a docked details pane cannot both fit, so the pane
 *  becomes a drawer over the tree that opens only while something is selected. */
const DRAWER_QUERY = "(max-width: 1099px)";

function readJson<T>(key: string, fallback: T, check: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return check(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: widths last for this session only */
  }
}
const isColWidths = (v: unknown): v is ColWidths =>
  typeof v === "object" && v !== null && (Object.keys(COL_DEFAULT) as ColKey[]).every((k) => typeof (v as Record<string, unknown>)[k] === "number");
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Horizontal drag helper shared by the column resizers and the pane splitter.
 * Calls `onMove(deltaX)` while dragging and `onEnd()` on release.
 */
function useHorizontalDrag() {
  const [active, setActive] = useState<string | null>(null);
  const start = useCallback((e: ReactPointerEvent, id: string, onMove: (dx: number) => void, onEnd: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    setActive(id);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => onMove(ev.clientX - x0);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setActive(null);
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);
  return { active, start };
}

function HeadStat({ value, label, big, title }: { value: string; label: string; big?: boolean; title?: string }) {
  return (
    <div className="flex flex-col leading-tight" title={title}>
      <span className={cn("stat tabular-nums", big ? "text-xl" : "text-sm")}>{value}</span>
      <span className="text-[11px] text-muted">{label}</span>
    </div>
  );
}

export function TreeView() {
  const nodes = useApp((s) => s.nodes);
  const sessions = useApp((s) => s.sessions);
  const root = useApp((s) => s.root);
  const rollup = useApp((s) => s.rollup);
  const expanded = useApp((s) => s.expanded);
  const subjectFilter = useApp((s) => s.subjectFilter);
  const setSubjectFilter = useApp((s) => s.setSubjectFilter);
  const treeSort = useApp((s) => s.treeSort);
  const setTreeSort = useApp((s) => s.setTreeSort);
  const selectedNodeId = useApp((s) => s.selectedNodeId);
  const addSubject = useApp((s) => s.addSubject);
  const expandAll = useApp((s) => s.expandAll);
  const deleteNode = useApp((s) => s.deleteNode);
  const rollupMode = useApp((s) => s.settings.rollup_mode);
  const [pendingDelete, setPendingDelete] = useState<DbNode | null>(null);

  const kids = useMemo(() => childrenOf(nodes), [nodes]);
  const subjects = kids.get(null) ?? [];
  const deadlines = useMemo(() => effectiveDeadlines(kids, (id) => (rollup.get(id)?.pct ?? 0) >= 100), [kids, rollup]);
  const priorities = useMemo(() => effectivePriorities(kids, (id) => (rollup.get(id)?.pct ?? 0) >= 100), [kids, rollup]);
  const todayMs = startOfDay(new Date()).getTime();

  const rows = useMemo(() => {
    const ctx = { rollup, deadlines, priorities, today: new Date(todayMs) };
    const out: FlatRow[] = [];
    const walk = (parent: string | null) => {
      for (const n of sortSiblings(kids.get(parent) ?? [], treeSort, ctx)) {
        if (parent === null && subjectFilter && n.id !== subjectFilter) continue;
        const ch = kids.get(n.id) ?? [];
        const isOpen = expanded.has(n.id);
        out.push({ node: n, hasChildren: ch.length > 0, expanded: isOpen });
        if (isOpen) walk(n.id);
      }
    };
    walk(null);
    return out;
  }, [kids, expanded, subjectFilter, treeSort, rollup, deadlines, priorities, todayMs]);

  /**
   * Weight only means something to a child whose parent rolls up by weight, so
   * the column exists only when some node in the tree is actually in that case.
   * Read across every node rather than the visible rows, or collapsing a group
   * would make the column disappear and come back.
   */
  const showWeight = useMemo(
    () => nodes.some((n) => n.parent_id !== null && rollup.get(n.parent_id)?.mode === "weight"),
    [nodes, rollup],
  );

  const totalHours = useMemo(() => creditedSessions(sessions).reduce((a, s) => a + s.actual_seconds, 0) / 3600, [sessions]);

  // Keep selection valid
  useEffect(() => {
    if (selectedNodeId && !nodes.some((n) => n.id === selectedNodeId)) useApp.getState().select(null);
  }, [nodes, selectedNodeId]);

  const requestDelete = (n: DbNode) => {
    const hasKids = (kids.get(n.id) ?? []).length > 0;
    const hasSessions = sessions.some((s) => s.node_id === n.id);
    if (hasKids || hasSessions) setPendingDelete(n);
    else deleteNode(n.id);
  };

  const allIds = nodes.filter((n) => (kids.get(n.id) ?? []).length > 0).map((n) => n.id);
  const anyExpanded = expanded.size > 0;
  const manual = treeSort === "manual";
  const sortOption = TREE_SORT_OPTIONS.find((o) => o.id === treeSort) ?? TREE_SORT_OPTIONS[0];

  /* ---------------------------------------------------- resizable layout */
  const [cols, setCols] = useState<ColWidths>(() => readJson(COLS_KEY, COL_DEFAULT, isColWidths));
  const [detailW, setDetailW] = useState<number>(() => clamp(readJson(DETAIL_KEY, DETAIL_DEFAULT, isNumber), DETAIL_MIN, DETAIL_MAX));
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const detailRef = useRef(detailW);
  detailRef.current = detailW;
  const drag = useHorizontalDrag();
  const drawer = useMediaQuery(DRAWER_QUERY);

  const startColResize = (e: ReactPointerEvent, key: ColKey) => {
    const from = colsRef.current[key];
    drag.start(
      e,
      key,
      (dx) => setCols((c) => ({ ...c, [key]: clamp(Math.round(from + dx), COL_MIN[key], COL_MAX) })),
      () => writeJson(COLS_KEY, colsRef.current),
    );
  };
  const resetCol = (key: ColKey) => {
    const next = { ...colsRef.current, [key]: COL_DEFAULT[key] };
    setCols(next);
    writeJson(COLS_KEY, next);
  };
  const startPaneResize = (e: ReactPointerEvent) => {
    const from = detailRef.current;
    drag.start(
      e,
      "pane",
      (dx) => setDetailW(clamp(Math.round(from - dx), DETAIL_MIN, DETAIL_MAX)),
      () => writeJson(DETAIL_KEY, detailRef.current),
    );
  };

  const gridStyle = useMemo<CSSProperties>(() => {
    const weightCol = showWeight ? `${cols.weight}px ` : "";
    const fixed = PROGRESS_MIN + cols.pct + cols.est + (showWeight ? cols.weight : 0) + cols.due;
    const gaps = (showWeight ? 5 : 4) * 12; // column-gap 0.75rem between the columns
    return {
      // Progress keeps its own flexible width (like before); the numeric columns are resizable
      "--tree-cols": `minmax(${NAME_MIN}px,1fr) minmax(${PROGRESS_MIN}px,${PROGRESS_MAX}px) ${cols.pct}px ${cols.est}px ${weightCol}${cols.due}px`,
      "--tree-min-w": `${NAME_MIN + fixed + gaps + 32}px`,
    } as CSSProperties;
  }, [cols, showWeight]);

  // plain render helper (not a component) so header cells keep their identity across renders
  const resizer = (col: ColKey) => (
    <span
      className="col-resizer"
      data-active={drag.active === col}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => startColResize(e, col)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        resetCol(col);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <header className="panel-head flex flex-wrap items-center gap-x-5 gap-y-2 whitespace-nowrap px-4 py-2.5">
        {/* Each figure sits over its label so the summary takes a third of the
            width it did as a sentence, and the controls stay on the same line. */}
        <HeadStat value={`${root.pct.toFixed(1)}%`} label={`overall · ${root.subjectCount} project${root.subjectCount === 1 ? "" : "s"}`} big title={`Projects combine by ${ROLLUP_LABEL[rollupMode].toLowerCase()}`} />
        <div className="divider h-8 w-px" />
        <HeadStat value={fmtHours(totalHours)} label="logged" />
        {root.estHours !== null && (
          <>
            <HeadStat value={fmtHours(root.estHours)} label="estimated" />
            <HeadStat value={fmtHours(root.remainingHours ?? 0)} label="remaining" />
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted" title={sortOption.hint}>
            <ArrowUpDown size={14} className={cn(!manual && "text-fg")} aria-hidden />
            <select className={cn("input", !manual && "font-medium")} value={treeSort} onChange={(e) => setTreeSort(e.target.value as typeof treeSort)} aria-label="Sort tree">
              {TREE_SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <select className="input" value={subjectFilter ?? ""} onChange={(e) => setSubjectFilter(e.target.value || null)} aria-label="Filter by project">
            <option value="">All projects</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost btn-sm"
            title={anyExpanded ? "Collapse all" : "Expand all"}
            onClick={() => (anyExpanded ? useApp.setState({ expanded: new Set() }) : expandAll(allIds))}
          >
            {anyExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
          </button>
          <button className="btn btn-primary" onClick={() => addSubject()}>
            <Plus size={14} /> Project
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-auto" onClick={(e) => e.target === e.currentTarget && useApp.getState().select(null)}>
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted">
              <p className="text-sm">No projects yet. Create one to start structuring your workload.</p>
              <button className="btn btn-primary" onClick={() => addSubject()}>
                <Plus size={14} /> New project
              </button>
              <p className="text-xs">
                Tip: press <span className="kbd">N</span> anywhere to add a task under the selected node.
              </p>
            </div>
          ) : (
            <div className="py-2" style={gridStyle}>
              <div className="table-head tree-grid px-4 pb-1">
                <span>Name</span>
                <span>Progress</span>
                <span className="relative text-right">
                  %{resizer("pct")}
                </span>
                <span className="relative text-right" title="Estimated effort">
                  Est.
                  {resizer("est")}
                </span>
                {showWeight && (
                  <span className="relative text-right" title="Share among siblings, used by the custom-weights roll-up">
                    Weight
                    {resizer("weight")}
                  </span>
                )}
                <span className="relative text-right" title="Own deadline, or the earliest deadline among the tasks below (shown in italics)">
                  Due
                  {resizer("due")}
                </span>
              </div>
              {!manual && (
                <p className="px-4 pb-1 text-[11px] text-muted">
                  Sorted by {sortOption.label.toLowerCase()} within each group. Switch to manual order to drag rows.
                </p>
              )}
              {rows.map((r) => (
                <TreeRow
                  key={r.node.id}
                  row={r}
                  siblings={kids.get(r.node.parent_id) ?? []}
                  due={deadlines.get(r.node.id) as EffectiveDeadline | undefined}
                  priority={priorities.get(r.node.id) as EffectivePriority | undefined}
                  today={todayMs}
                  manual={manual}
                  showWeight={showWeight}
                  onDelete={requestDelete}
                />
              ))}
            </div>
          )}
        </section>
        {drawer ? (
          selectedNodeId && (
            <aside className="drawer absolute inset-y-0 right-0 z-20 overflow-y-auto border-l border-app bg-panel" style={{ width: Math.min(detailW, 380) }}>
              <div className="panel-head sticky top-0 z-10 flex items-center justify-between py-1.5 pl-4 pr-2">
                <span className="table-head">Details</span>
                <button className="btn btn-ghost btn-sm" onClick={() => useApp.getState().select(null)} aria-label="Close details" title="Close (Esc)">
                  <X size={14} />
                </button>
              </div>
              <NodeDetail onDelete={requestDelete} />
            </aside>
          )
        ) : (
          <>
            <div
              className="pane-splitter"
              data-active={drag.active === "pane"}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize details pane"
              title="Drag to resize · double-click to reset"
              onPointerDown={startPaneResize}
              onDoubleClick={() => {
                setDetailW(DETAIL_DEFAULT);
                writeJson(DETAIL_KEY, DETAIL_DEFAULT);
              }}
            />
            <aside className="shrink-0 overflow-y-auto border-l border-app bg-panel" style={{ width: detailW }}>
              <NodeDetail onDelete={requestDelete} />
            </aside>
          </>
        )}
      </div>

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name}"?`}
        description="Child tasks and their percent history are removed. Sessions logged against them are kept and moved to the Unassigned inbox. You can undo this."
        footer={
          <>
            <button className="btn" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                if (pendingDelete) deleteNode(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </button>
          </>
        }
      />
    </div>
  );
}
