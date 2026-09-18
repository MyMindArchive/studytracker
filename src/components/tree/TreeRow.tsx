import { useEffect, useRef, useState, type DragEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { CheckSquare, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { useApp } from "../../store/app";
import { useTimer } from "../../store/timer";
import { ProgressBar } from "../ui/ProgressBar";
import { RangeSlider } from "../ui/RangeSlider";
import { cn } from "../../lib/cn";
import type { DbNode } from "../../types";
import type { FlatRow } from "./TreeView";
import { subjectIndex, weightOf, ROLLUP_LABEL } from "../../lib/rollup";
import type { EffectiveDeadline } from "../../lib/treeSort";
import { relativeDue } from "../../lib/time";

type DropZone = "before" | "after" | "inside" | null;

/** Id of the row being dragged. WebKit does not expose custom dataTransfer
 *  types during dragover, so the id is tracked here rather than read back. */
let draggingId: string | null = null;

export function TreeRow({
  row,
  siblings,
  due,
  today,
  manual,
  onDelete,
}: {
  row: FlatRow;
  siblings: DbNode[];
  /** own deadline, or the earliest one below (inherited) */
  due?: EffectiveDeadline;
  /** start of today, ms — passed in so every row agrees on the date */
  today: number;
  /** true when the tree is in manual order; drag & drop is only allowed then */
  manual: boolean;
  onDelete: (n: DbNode) => void;
}) {
  const { node, hasChildren, expanded } = row;
  const roll = useApp((s) => s.rollup.get(node.id));
  const selected = useApp((s) => s.selectedNodeId === node.id);
  const select = useApp((s) => s.select);
  const toggleExpanded = useApp((s) => s.toggleExpanded);
  const renameNode = useApp((s) => s.renameNode);
  const patchNode = useApp((s) => s.patchNode);
  const setPct = useApp((s) => s.setPct);
  const addChild = useApp((s) => s.addChild);
  const duplicateNode = useApp((s) => s.duplicateNode);
  const moveNode = useApp((s) => s.moveNode);
  const editPctRequest = useApp((s) => s.editPctRequest);
  const nodes = useApp((s) => s.nodes);
  const parentMode = useApp((s) => (node.parent_id ? s.rollup.get(node.parent_id)?.mode : undefined));
  const checklist = useApp((s) => s.checklistStats.get(node.id));
  /** percent is set by the checklist, not typed */
  const fromChecklist = isLeafRow(hasChildren) && !!checklist && checklist.total > 0;
  const subject = subjectIndex(nodes).get(node.id);
  const color = subject?.color ?? null;
  const unit = subject?.unit ?? "hours";

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(node.name);
  const [pctDraft, setPctDraft] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropZone>(null);
  const pctRef = useRef<HTMLInputElement>(null);
  const isLeaf = !hasChildren;
  const pct = roll?.pct ?? 0;

  useEffect(() => setNameDraft(node.name), [node.name]);

  // "E" shortcut: focus percent editor of the selected row
  useEffect(() => {
    if (selected && editPctRequest > 0 && isLeaf) {
      pctRef.current?.focus();
      pctRef.current?.select();
    }
  }, [editPctRequest, selected, isLeaf]);

  const commitName = () => {
    setEditingName(false);
    const v = nameDraft.trim();
    if (v && v !== node.name) renameNode(node.id, v);
    else setNameDraft(node.name);
  };

  const commitPct = (raw?: string) => {
    const v = raw ?? pctDraft;
    if (v === null) return;
    const n = Number(v);
    setPctDraft(null);
    if (v.trim() !== "" && Number.isFinite(n)) setPct(node.id, Math.max(0, Math.min(100, n)));
  };

  const commitWeight = (raw: string) => {
    const n = Number(raw.trim());
    if (raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n !== node.weight) patchNode(node.id, { weight: n });
  };

  const commitEffort = (raw: string) => {
    const v = raw.trim();
    const n = v === "" ? null : Number(v);
    if (n !== node.est_effort && (n === null || Number.isFinite(n))) patchNode(node.id, { est_effort: n });
  };

  /* ---------------------------------------------------------- drag & drop */
  const onDragStart = (e: DragEvent) => {
    draggingId = node.id;
    e.dataTransfer.setData("text/plain", node.id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    draggingId = null;
    setDrop(null);
  };
  const zoneFor = (e: DragEvent): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (y < 0.25) return "before";
    if (y > 0.75) return "after";
    return "inside";
  };
  const onDragOver = (e: DragEvent) => {
    if (!manual || !draggingId || draggingId === node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const z = zoneFor(e);
    if (z !== drop) setDrop(z);
  };
  const onDrop = (e: DragEvent) => {
    if (!manual) return;
    e.preventDefault();
    const dragged = draggingId ?? e.dataTransfer.getData("text/plain");
    const zone = zoneFor(e);
    setDrop(null);
    draggingId = null;
    if (!dragged || dragged === node.id) return;
    if (zone === "inside") {
      const count = nodes.filter((n) => n.parent_id === node.id && n.id !== dragged).length;
      moveNode(dragged, node.id, count);
    } else {
      const sibs = siblings.filter((s) => s.id !== dragged);
      const idx = sibs.findIndex((s) => s.id === node.id);
      moveNode(dragged, node.parent_id, zone === "before" ? idx : idx + 1);
    }
  };

  const startTimerHere = () => {
    useTimer.getState().setNode(node.id);
    useApp.getState().setView("timer");
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="tree-row group tree-grid px-4 py-1 text-sm"
          data-selected={selected}
          data-drop={drop ?? undefined}
          onDragOver={onDragOver}
          onDragLeave={() => setDrop(null)}
          onDrop={onDrop}
          onClick={() => select(node.id)}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("input")) return;
            setEditingName(true);
          }}
        >
          <div
            className={cn("flex min-w-0 items-center gap-1", manual && "cursor-grab active:cursor-grabbing")}
            style={{ paddingLeft: node.depth * 18 }}
            draggable={manual && !editingName}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            title={manual ? "Drag to reorder; drop on the middle of a row to nest. Alt+↑/↓ moves the selected row." : "Switch to manual order to drag rows"}
          >
            <GripVertical size={14} className={cn("shrink-0 text-muted", manual ? "opacity-30 group-hover:opacity-80" : "opacity-10")} />
            <button
              className={cn("shrink-0 rounded p-0.5 text-muted hover:text-fg", !hasChildren && "invisible")}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.id);
              }}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {node.parent_id === null && <span className="dot mr-1 h-2.5 w-2.5" style={{ background: color ?? "var(--accent)" }} />}
            {editingName ? (
              <input
                autoFocus
                className="input w-full py-0.5"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") {
                    setNameDraft(node.name);
                    setEditingName(false);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={cn("truncate", node.parent_id === null && "font-medium", roll?.status === "Done" && "text-muted line-through decoration-1")} title={node.name}>
                {node.name}
              </span>
            )}
            {fromChecklist && (
              <span className="chip ml-1.5 inline-flex shrink-0 items-center gap-0.5" title="Checklist items done">
                <CheckSquare size={10} /> {checklist!.done}/{checklist!.total}
              </span>
            )}
            {parentMode === "weight" && weightOf(node) !== 1 && (
              <span className="chip ml-1.5 shrink-0" title="Weight among siblings">
                ×{fmtEffort(weightOf(node))}
              </span>
            )}
          </div>

          <div className="flex items-center">
            {isLeaf && !fromChecklist ? (
              <RangeSlider
                value={Math.round(pct)}
                onCommit={(v) => setPct(node.id, v)}
                className="h-2 w-full cursor-pointer"
                style={{ accentColor: color ?? "var(--accent)" }}
                ariaLabel="Percent complete"
              />
            ) : (
              <ProgressBar pct={pct} color={color} />
            )}
          </div>

          <div className="text-right tabular-nums">
            {isLeaf && !fromChecklist ? (
              <input
                ref={pctRef}
                type="number"
                min={0}
                max={100}
                className="input w-16 py-0.5 text-right"
                value={pctDraft ?? Math.round(pct)}
                onFocus={(e) => {
                  setPctDraft(String(Math.round(pct)));
                  e.target.select();
                }}
                onChange={(e) => setPctDraft(e.target.value)}
                onBlur={() => commitPct()}
                onKeyDown={(e) => {
                  const el = e.target as HTMLInputElement;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitPct(el.value);
                    el.blur();
                  }
                  if (e.key === "Escape") {
                    setPctDraft(null);
                    el.blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-muted">{pct.toFixed(1)}%</span>
            )}
          </div>

          <div className="flex items-center justify-end gap-1 text-right tabular-nums">
            {isLeaf ? (
              <input
                type="number"
                min={0}
                step="any"
                className="input w-20 py-0.5 text-right"
                placeholder="–"
                defaultValue={node.est_effort ?? ""}
                key={`${node.id}-${node.est_effort}`}
                onBlur={(e) => commitEffort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEffort((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-muted">{fmtEffort(roll?.estTotal ?? 0)}</span>
            )}
            <span className="w-8 truncate text-left text-[10px] text-muted" title={unit}>
              {shortUnit(unit)}
            </span>
          </div>

          <div className="text-right tabular-nums">
            {node.parent_id === null ? (
              <span className="text-muted" title="Projects combine by estimated hours (or equally when units differ), not by weight">
                –
              </span>
            ) : (
              <input
                type="number"
                min={0}
                step="any"
                className={cn("input w-14 py-0.5 text-right", parentMode !== "weight" && "opacity-50")}
                title={parentMode === "weight" ? "Weight among siblings" : `Not used: parent rolls up by ${ROLLUP_LABEL[parentMode ?? "equal"].toLowerCase()}`}
                defaultValue={node.weight ?? 1}
                key={`${node.id}-w-${node.weight}`}
                onBlur={(e) => commitWeight(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitWeight((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>

          <div className="text-right">
            {due ? (
              <DueLabel due={due} today={today} done={roll?.status === "Done"} />
            ) : (
              <span className="due" title="No deadline. Set one in the details pane.">
                –
              </span>
            )}
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu z-50">
          <Item onSelect={() => addChild(node.id)}>Add child task</Item>
          <Item onSelect={startTimerHere}>Start timer here</Item>
          <Item onSelect={() => setEditingName(true)}>Rename</Item>
          <Item onSelect={() => duplicateNode(node.id)}>Duplicate</Item>
          <ContextMenu.Separator className="menu-sep" />
          <Item danger onSelect={() => onDelete(node)}>
            Delete…
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function DueLabel({ due, today, done }: { due: EffectiveDeadline; today: number; done: boolean }) {
  const rel = relativeDue(due.date, new Date(today));
  const title = `${due.inherited ? "Earliest open task deadline: " : "Due "}${due.date}${done ? " (finished)" : ""}`;
  return (
    <span className="due" data-tone={done ? "done" : rel.tone} data-inherited={due.inherited} title={title}>
      {rel.label}
    </span>
  );
}

function Item({ children, onSelect, danger }: { children: React.ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn("menu-item", danger && "text-danger")}
    >
      {children}
    </ContextMenu.Item>
  );
}

function isLeafRow(hasChildren: boolean): boolean {
  return !hasChildren;
}

export function fmtEffort(n: number): string {
  if (!Number.isFinite(n)) return "–";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function shortUnit(u: string): string {
  const m: Record<string, string> = { hours: "h", pages: "pg", problems: "pr", chapters: "ch" };
  return m[u.toLowerCase()] ?? u.slice(0, 3);
}
