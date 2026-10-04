import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CheckSquare, Target, X } from "lucide-react";
import { startOfDay } from "date-fns";
import { useApp } from "../../store/app";
import { childrenOf } from "../../lib/rollup";
import { FOCUS_SORT_OPTIONS, focusItems, isFocusSort, sortFocus, type FocusItem, type FocusSort } from "../../lib/focus";
import type { DbNode } from "../../types";
import { NodeDetail } from "../tree/NodeDetail";
import { DueLabel, NoteMark, PriorityChip, fmtEffort } from "../tree/TreeRow";
import { ProgressBar } from "../ui/ProgressBar";
import { RangeSlider } from "../ui/RangeSlider";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";

const SORT_KEY = "studytracker.focus_sort";
const DRAWER_QUERY = "(max-width: 1099px)";
const PANE_W = 340;

function loadSort(): FocusSort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return isFocusSort(v) ? v : "combined";
  } catch {
    return "combined";
  }
}

/** Name · project · priority · due · progress · percent; the project column folds under the name when narrow. */
const GRID = "grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_2rem_5.5rem_7rem_2.75rem] items-center gap-x-3 max-[699px]:grid-cols-[minmax(0,1fr)_2rem_5rem_2.75rem]";

export function FocusView() {
  const nodes = useApp((s) => s.nodes);
  const sessions = useApp((s) => s.sessions);
  const rollup = useApp((s) => s.rollup);
  const dailyTarget = useApp((s) => s.settings.daily_target_hours);
  const selectedNodeId = useApp((s) => s.selectedNodeId);
  const select = useApp((s) => s.select);
  const deleteNode = useApp((s) => s.deleteNode);
  const [sort, setSortState] = useState<FocusSort>(loadSort);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DbNode | null>(null);
  const drawer = useMediaQuery(DRAWER_QUERY);
  const todayMs = startOfDay(new Date()).getTime();

  const setSort = (v: FocusSort) => {
    setSortState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* storage unavailable: the order lasts for this session only */
    }
  };

  const items = useMemo(
    () => sortFocus(focusItems({ nodes, rollup, dailyTargetHours: dailyTarget, today: new Date(todayMs) }), sort),
    [nodes, rollup, dailyTarget, todayMs, sort],
  );
  const kids = useMemo(() => childrenOf(nodes), [nodes]);

  // Keep selection valid
  useEffect(() => {
    if (selectedNodeId && !nodes.some((n) => n.id === selectedNodeId)) select(null);
  }, [nodes, selectedNodeId, select]);

  const requestDelete = (n: DbNode) => {
    const hasKids = (kids.get(n.id) ?? []).length > 0;
    const hasSessions = sessions.some((s) => s.node_id === n.id);
    if (hasKids || hasSessions) setPendingDelete(n);
    else deleteNode(n.id);
  };

  const overdue = items.filter((i) => i.days !== null && i.days < 0).length;
  const option = FOCUS_SORT_OPTIONS.find((o) => o.id === sort) ?? FOCUS_SORT_OPTIONS[0];

  const detail = selectedNodeId && (
    <aside
      className={cn("overflow-y-auto border-l border-app bg-panel", drawer ? "drawer absolute inset-y-0 right-0 z-20" : "shrink-0")}
      style={{ width: drawer ? Math.min(PANE_W, 380) : PANE_W }}
    >
      <div className="panel-head sticky top-0 z-10 flex items-center justify-between py-1.5 pl-4 pr-2">
        <span className="table-head">Details</span>
        <button className="btn btn-ghost btn-sm" onClick={() => select(null)} aria-label="Close details" title="Close (Esc)">
          <X size={14} />
        </button>
      </div>
      <NodeDetail onDelete={requestDelete} />
    </aside>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="panel-head flex flex-wrap items-center gap-x-5 gap-y-2 whitespace-nowrap px-4 py-2.5">
        <div className="flex flex-col leading-tight">
          <span className="stat text-xl tabular-nums">{items.length}</span>
          <span className="text-[11px] text-muted">marked task{items.length === 1 ? "" : "s"}</span>
        </div>
        {overdue > 0 && (
          <div className="flex flex-col leading-tight">
            <span className="stat text-sm tabular-nums text-danger">{overdue}</span>
            <span className="text-[11px] text-muted">overdue</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="seg" role="tablist" aria-label="Order">
            {FOCUS_SORT_OPTIONS.map((o) => (
              <button key={o.id} role="tab" aria-selected={sort === o.id} className="seg-item" data-active={sort === o.id} title={o.hint} onClick={() => setSort(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-auto" onClick={(e) => e.target === e.currentTarget && select(null)}>
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted">
              <Target size={28} className="opacity-50" />
              <p className="max-w-sm text-sm">Nothing is marked yet. Give a task a priority or a deadline in the tree (right-click → Priority, or the details pane) and it shows up here.</p>
            </div>
          ) : (
            <div className="py-2">
              <div className={cn("table-head px-4 pb-1", GRID)}>
                <span>Task</span>
                <span className="max-[699px]:hidden">Project</span>
                <span className="text-center" title="Priority">
                  Pr.
                </span>
                <span className="text-right">Due</span>
                <span className="max-[699px]:hidden">Progress</span>
                <span className="text-right">%</span>
              </div>
              <p className="px-4 pb-1 text-[11px] text-muted">{option.hint}. Each task is the deepest one you marked; click the project to see where it sits.</p>
              {items.map((it) => (
                <FocusRow
                  key={it.node.id}
                  item={it}
                  today={todayMs}
                  sort={sort}
                  open={openId === it.node.id}
                  onToggle={() => setOpenId((cur) => (cur === it.node.id ? null : it.node.id))}
                  siblings={it.node.parent_id ? (kids.get(it.node.parent_id) ?? []) : []}
                />
              ))}
            </div>
          )}
        </section>
        {detail}
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

function scoreTitle(it: FocusItem): string {
  const parts = [`Score ${Math.round(it.score)} = half priority (${Math.round(it.priorityScore)}) + half deadline (${Math.round(it.deadlineScore)})`];
  if (it.days !== null && it.days < 0) parts.push("Overdue counts as the full deadline score");
  else if (it.hoursPerDay !== null) parts.push(`${fmtEffort(Math.round(it.hoursPerDay * 10) / 10)} h/day left until due`);
  else if (it.noEstimate) parts.push("No estimate: the deadline part is read off the days left");
  return parts.join("\n");
}

function FocusRow({
  item,
  today,
  sort,
  open,
  onToggle,
  siblings,
}: {
  item: FocusItem;
  today: number;
  sort: FocusSort;
  open: boolean;
  onToggle: () => void;
  siblings: DbNode[];
}) {
  const { node, subject } = item;
  const selected = useApp((s) => s.selectedNodeId === node.id);
  const select = useApp((s) => s.select);
  const setPct = useApp((s) => s.setPct);
  const isLeaf = useApp((s) => s.rollup.get(node.id)?.isLeaf ?? true);
  const checklist = useApp((s) => s.checklistStats.get(node.id));
  const fromChecklist = isLeaf && !!checklist && checklist.total > 0;
  const color = subject.color;
  const path = [...item.ancestors.map((a) => a.name), node.name].join(" › ");
  const project = (
    <button
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded text-left text-muted hover:text-fg"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={`${path}\nClick to ${open ? "hide" : "show"} where it sits`}
      aria-expanded={open}
    >
      <span className="dot h-2 w-2 shrink-0" style={{ background: color ?? "var(--accent)" }} />
      <span className="truncate text-xs">{subject.id === node.id ? "(project)" : subject.name}</span>
      {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0 opacity-60" />}
    </button>
  );

  return (
    <div className={cn(item.blocked && "opacity-60")}>
      <div
        className={cn("tree-row group px-4 py-1.5 text-sm", GRID)}
        data-selected={selected}
        onClick={() => select(node.id)}
        title={sort === "combined" ? scoreTitle(item) : undefined}
      >
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate" title={node.name}>
              {node.name}
            </span>
            {node.note && <NoteMark note={node.note} />}
            {item.blocked && <span className="chip ml-1 shrink-0">blocked</span>}
            {fromChecklist && (
              <span className="chip ml-1 inline-flex shrink-0 items-center gap-0.5" title="Checklist items done">
                <CheckSquare size={10} /> {checklist!.done}/{checklist!.total}
              </span>
            )}
            {item.noEstimate && (
              <span className="chip ml-1 shrink-0 text-muted" title="No estimated effort, so the deadline part of the score is read off the days left">
                no estimate
              </span>
            )}
          </div>
          <div className="min-[700px]:hidden">{project}</div>
        </div>
        <div className="min-w-0 max-[699px]:hidden">{project}</div>
        <div className="flex justify-center">
          {item.priority !== null ? <PriorityChip priority={{ rank: item.priority, inherited: item.priorityInherited }} /> : <span className="due">–</span>}
        </div>
        <div className="text-right">
          {item.deadline ? <DueLabel due={{ date: item.deadline, inherited: item.deadlineInherited }} today={today} done={false} /> : <span className="due">–</span>}
        </div>
        <div className="flex items-center max-[699px]:hidden" onClick={(e) => e.stopPropagation()}>
          {isLeaf && !fromChecklist ? (
            <RangeSlider value={Math.round(item.pct)} onCommit={(v) => setPct(node.id, v)} className="w-full" color={color} ariaLabel={`Percent complete of ${node.name}`} />
          ) : (
            <span className="w-full" title={fromChecklist ? "Set by the checklist" : "Rolled up from the tasks below"}>
              <ProgressBar pct={item.pct} color={color} />
            </span>
          )}
        </div>
        <div className="text-right text-xs tabular-nums text-muted">{Math.round(item.pct)}%</div>
      </div>
      {open && <Context item={item} siblings={siblings} />}
    </div>
  );
}

/** The branch above a task: its ancestors from the project down, then the task among its siblings. */
function Context({ item, siblings }: { item: FocusItem; siblings: DbNode[] }) {
  const rollup = useApp((s) => s.rollup);
  const select = useApp((s) => s.select);
  const selectedNodeId = useApp((s) => s.selectedNodeId);
  const color = item.subject.color ?? "var(--accent)";
  const line = (n: DbNode, depth: number, kind: "ancestor" | "self" | "sibling") => {
    const pct = rollup.get(n.id)?.pct ?? 0;
    return (
      <button
        key={n.id}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-0.5 text-left text-xs hover:bg-[var(--panel-2)]",
          kind === "sibling" && "text-muted",
          kind === "self" && "font-medium",
          selectedNodeId === n.id && "bg-[var(--sel)]",
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => select(n.id)}
      >
        {depth === 0 ? <span className="dot h-2 w-2 shrink-0" style={{ background: color }} /> : <span className="shrink-0 text-muted">└</span>}
        <span className="truncate">{n.name}</span>
        {kind === "self" && <span className="shrink-0 text-[10px] text-muted">◀ this task</span>}
        <span className="ml-auto shrink-0 tabular-nums text-muted">{Math.round(pct)}%</span>
      </button>
    );
  };
  const depth = item.ancestors.length;
  return (
    <div className="mx-4 mb-1.5 rounded border border-app bg-panel py-1">
      {item.ancestors.map((a, i) => line(a, i, "ancestor"))}
      {(siblings.length ? siblings : [item.node]).map((s) => line(s, depth, s.id === item.node.id ? "self" : "sibling"))}
    </div>
  );
}
