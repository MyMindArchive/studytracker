import { useMemo, useState } from "react";
import { Play, Trash2, Plus, CheckSquare, CalendarPlus } from "lucide-react";
import { addWeeks } from "date-fns";
import { useApp } from "../../store/app";
import { useTimer } from "../../store/timer";
import { Field, NumberInput } from "../ui/Field";
import { Sparkline } from "../ui/Sparkline";
import { ProgressBar } from "../ui/ProgressBar";
import { RangeSlider } from "../ui/RangeSlider";
import { LogTimeDialog } from "../time/LogTimeDialog";
import type { DbNode } from "../../types";
import { ROLLUP_MODES, SUBJECT_COLORS, type RollupMode } from "../../types";
import { computeRollup, subjectIndex, childrenOf, ROLLUP_HELP, ROLLUP_LABEL } from "../../lib/rollup";
import { pctAsOf, creditedSessions } from "../../lib/stats";
import { fmtDuration, fmtHours, fromIso, weekKey } from "../../lib/time";
import { cn } from "../../lib/cn";

const UNITS = ["hours", "pages", "problems", "chapters"];

export function NodeDetail({ onDelete }: { onDelete: (n: DbNode) => void }) {
  const id = useApp((s) => s.selectedNodeId);
  const nodes = useApp((s) => s.nodes);
  const sessions = useApp((s) => s.sessions);
  const history = useApp((s) => s.history);
  const rollup = useApp((s) => s.rollup);
  const patchNode = useApp((s) => s.patchNode);
  const setPct = useApp((s) => s.setPct);
  const addChild = useApp((s) => s.addChild);
  const updateSessionNote = useApp((s) => s.updateSessionNote);
  const deleteSession = useApp((s) => s.deleteSession);
  const select = useApp((s) => s.select);
  const checklistAll = useApp((s) => s.checklist);
  const addChecklistItem = useApp((s) => s.addChecklistItem);
  const toggleChecklistItem = useApp((s) => s.toggleChecklistItem);
  const renameChecklistItem = useApp((s) => s.renameChecklistItem);
  const deleteChecklistItem = useApp((s) => s.deleteChecklistItem);
  const [itemDraft, setItemDraft] = useState("");
  const [logOpen, setLogOpen] = useState(false);

  const settingsMode = useApp((s) => s.settings.rollup_mode);
  const children = useMemo(() => (id ? childrenOf(nodes).get(id) ?? [] : []), [nodes, id]);
  const items = useMemo(() => checklistAll.filter((i) => i.node_id === id), [checklistAll, id]);
  const itemsDone = items.filter((i) => i.done).length;
  const fromChecklist = items.length > 0;
  const submitItem = () => {
    if (!node || !itemDraft.trim()) return;
    addChecklistItem(node.id, itemDraft);
    setItemDraft("");
  };
  const node = nodes.find((n) => n.id === id);
  const roll = node ? rollup.get(node.id) : undefined;
  /** rule the parent uses to combine this node with its siblings */
  const parentMode: RollupMode = (node?.parent_id ? rollup.get(node.parent_id)?.mode : undefined) ?? settingsMode;

  const subject = node ? subjectIndex(nodes).get(node.id) : undefined;
  const isSubject = node?.parent_id === null;
  const isLeaf = roll?.isLeaf ?? false;

  const descendantIds = useMemo(() => {
    if (!node) return new Set<string>();
    const ids = new Set([node.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) if (n.parent_id && ids.has(n.parent_id) && !ids.has(n.id)) (ids.add(n.id), (grew = true));
    }
    return ids;
  }, [node, nodes]);

  const nodeSessions = useMemo(
    () => sessions.filter((s) => s.node_id && descendantIds.has(s.node_id)).sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [sessions, descendantIds],
  );

  const weekly = useMemo(() => {
    const now = new Date();
    const weeks = Array.from({ length: 8 }, (_, i) => weekKey(addWeeks(now, i - 7)));
    const m = new Map(weeks.map((w) => [w, 0]));
    for (const s of creditedSessions(nodeSessions)) {
      const w = weekKey(fromIso(s.started_at));
      if (m.has(w)) m.set(w, m.get(w)! + s.actual_seconds / 3600);
    }
    return weeks.map((w) => ({ week: w, hours: m.get(w)! }));
  }, [nodeSessions]);

  const sparkPoints = useMemo(() => {
    if (!node) return [];
    const relevant = history.filter((h) => descendantIds.has(h.node_id)).sort((a, b) => a.changed_at.localeCompare(b.changed_at));
    if (isLeaf) return relevant.map((h) => h.pct);
    const stamps = relevant.map((h) => h.changed_at).slice(-60);
    return stamps.map((t) => computeRollup(pctAsOf(nodes, history, fromIso(t))).get(node.id)?.pct ?? 0);
  }, [node, nodes, history, descendantIds, isLeaf]);

  if (!node || !roll) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">
        Select a project or task to see its details, sessions and history.
      </div>
    );
  }

  const totalSeconds = creditedSessions(nodeSessions).reduce((a, s) => a + s.actual_seconds, 0);
  const color = subject?.color ?? null;

  const startTimer = () => {
    useTimer.getState().setNode(node.id);
    useApp.getState().setView("timer");
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          {isSubject && <span className="dot h-3 w-3" style={{ background: color ?? "var(--accent)" }} />}
          <input
            className="input w-full text-base font-semibold"
            key={node.id + node.name}
            defaultValue={node.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== node.name) patchNode(node.id, { name: v });
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
          <StatusPill status={roll.status} />
          <span>{isSubject ? "Project" : isLeaf ? "Task" : "Group"}</span>
          <span>· {roll.leafCount} leaf task{roll.leafCount === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between">
          <span className="stat text-2xl">{roll.pct.toFixed(1)}%</span>
          <span className="text-xs text-muted">
            {fmtEff(roll.doneTotal)} / {fmtEff(roll.estTotal)} {subject?.unit ?? "hours"}
          </span>
        </div>
        <ProgressBar pct={roll.pct} color={color} className="mt-2" />
        {isLeaf && !fromChecklist && (
          <div className="mt-3 flex items-center gap-3">
            <RangeSlider value={Math.round(node.pct_complete)} onCommit={(v) => setPct(node.id, v)} className="flex-1" style={{ accentColor: color ?? "var(--accent)" }} ariaLabel="Percent complete" />
            <NumberInput value={Math.round(node.pct_complete)} min={0} max={100} step={1} className="input w-20 text-right" onChange={(v) => setPct(node.id, Math.max(0, Math.min(100, v ?? 0)))} />
            <span className="text-sm text-muted">%</span>
          </div>
        )}
        {isLeaf && fromChecklist && (
          <p className="mt-2 flex items-center gap-1 text-xs text-muted">
            <CheckSquare size={12} /> Set by the checklist: {itemsDone} of {items.length} done. Remove all items to type a percent again.
          </p>
        )}
        {!isLeaf && (
          <p className="mt-2 text-xs text-muted">
            <span className="font-medium text-fg">{ROLLUP_LABEL[roll.mode]}</span>
            {node.rollup_mode ? "" : " (inherited)"} · {ROLLUP_HELP[roll.mode]}
          </p>
        )}
      </div>

      <div className="card grid grid-cols-2 gap-x-4">
        {isLeaf && (
          <Field label="Estimated effort" hint={subject?.unit ?? "hours"}>
            <NumberInput value={node.est_effort} allowNull min={0} className="input w-full" onChange={(v) => patchNode(node.id, { est_effort: v })} />
          </Field>
        )}
        <Field label="Deadline" hint="shown in the Due column and used for sorting">
          <input type="date" className="input w-full" value={node.deadline ?? ""} onChange={(e) => patchNode(node.id, { deadline: e.target.value || null })} />
        </Field>
        {!isSubject && (
          <Field label="Weight" hint={parentMode === "weight" ? "share among siblings" : "only used when the parent rolls up by weight"}>
            <NumberInput value={node.weight ?? 1} min={0} step={0.5} className="input w-full" onChange={(v) => patchNode(node.id, { weight: Math.max(0, v ?? 1) })} />
          </Field>
        )}
        {!isLeaf && (
          <Field label="Roll-up" hint="how children combine" className="col-span-2">
            <select
              className="input w-full"
              value={node.rollup_mode ?? ""}
              onChange={(e) => patchNode(node.id, { rollup_mode: (e.target.value || null) as RollupMode | null })}
            >
              <option value="">Inherit ({ROLLUP_LABEL[parentMode]})</option>
              {ROLLUP_MODES.map((m) => (
                <option key={m} value={m}>
                  {ROLLUP_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>
        )}
        {isSubject && (
          <>
            <Field label="Unit">
              <input
                className="input w-full"
                list="unit-options"
                key={node.id + (node.unit ?? "")}
                defaultValue={node.unit ?? "hours"}
                onBlur={(e) => {
                  const v = e.target.value.trim() || "hours";
                  if (v !== node.unit) patchNode(node.id, { unit: v });
                }}
              />
              <datalist id="unit-options">
                {UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </Field>
            <Field label="Hours per unit" hint="conversion">
              <NumberInput value={node.hours_per_unit} allowNull min={0} className="input w-full" placeholder={(node.unit ?? "hours") === "hours" ? "1" : "–"} onChange={(v) => patchNode(node.id, { hours_per_unit: v })} />
            </Field>
            <Field label="Weekly target" hint="hours">
              <NumberInput value={node.weekly_target_hours} allowNull min={0} className="input w-full" onChange={(v) => patchNode(node.id, { weekly_target_hours: v })} />
            </Field>
            <Field label="Color">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SUBJECT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={cn("dot h-5 w-5 border-2", node.color === c ? "border-fg" : "border-transparent")}
                    style={{ background: c }}
                    onClick={() => patchNode(node.id, { color: c })}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </Field>
          </>
        )}
      </div>

      {isLeaf && (
        <div className="card">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="section-title">Checklist</span>
            <span className="text-xs text-muted">{items.length ? `${itemsDone} / ${items.length} · each item ${(100 / items.length).toFixed(0)} %` : "optional"}</span>
          </div>
          {items.length > 0 && (
            <ul className="flex flex-col">
              {items.map((it) => (
                <li key={it.id} className="group flex items-center gap-2 py-0.5">
                  <input type="checkbox" className="h-4 w-4 shrink-0" checked={it.done} onChange={() => toggleChecklistItem(it.id)} aria-label={it.label} />
                  <input
                    className={cn("input min-w-0 flex-1 border-transparent bg-transparent py-0.5", it.done && "text-muted line-through")}
                    key={it.id + it.label}
                    defaultValue={it.label}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== it.label) renameChecklistItem(it.id, v);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                  <button className="btn btn-ghost btn-sm text-muted opacity-0 group-hover:opacity-100 focus:opacity-100" title="Remove item" onClick={() => deleteChecklistItem(it.id)}>
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitItem();
            }}
          >
            <input
              className="input min-w-0 flex-1"
              placeholder={items.length ? "Add another item…" : "e.g. Theory, Exercise, Review — Enter to add"}
              value={itemDraft}
              onChange={(e) => setItemDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitItem();
                }
              }}
            />
            <button type="submit" className="btn btn-sm" disabled={!itemDraft.trim()} title="Add item">
              <Plus size={12} /> Add
            </button>
          </form>
          {items.length === 0 && <p className="mt-2 text-xs text-muted">Items count equally: ticking 2 of 3 sets this task to 67 %.</p>}
        </div>
      )}

      {!isLeaf && (
        <div className="card">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="section-title">Children</span>
            <span className="text-xs text-muted">{ROLLUP_LABEL[roll.mode]}</span>
          </div>
          <div className="table-head grid grid-cols-[1fr_52px_64px] gap-2 pb-1">
            <span>Task</span>
            <span className="text-right">%</span>
            <span className="text-right">Weight</span>
          </div>
          <ul className="flex flex-col gap-1">
            {children.map((c) => {
              const cr = rollup.get(c.id);
              return (
                <li key={c.id} className="grid grid-cols-[1fr_52px_64px] items-center gap-2 text-sm">
                  <button className="truncate text-left hover:underline" title={c.name} onClick={() => select(c.id)}>
                    {c.name}
                  </button>
                  <span className="text-right text-xs tabular-nums text-muted">{(cr?.pct ?? 0).toFixed(0)}%</span>
                  <NumberInput
                    value={c.weight ?? 1}
                    min={0}
                    step={0.5}
                    className={cn("input w-full py-0.5 text-right", roll.mode !== "weight" && "opacity-50")}
                    onChange={(v) => patchNode(c.id, { weight: Math.max(0, v ?? 1) })}
                  />
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">
            {roll.mode === "weight"
              ? "A child with weight 2 counts twice; 0 leaves it out."
              : `Weights are ignored while this ${isSubject ? "project" : "group"} rolls up by ${ROLLUP_LABEL[roll.mode].toLowerCase()}. Switch Roll-up to Custom weights to use them.`}
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <button className="btn btn-primary flex-1" onClick={startTimer}>
          <Play size={14} /> Start timer
        </button>
        <button className="btn" onClick={() => addChild(node.id)} title="Add child (N)">
          <Plus size={14} /> Child
        </button>
        <button className="btn btn-danger" onClick={() => onDelete(node)} title="Delete">
          <Trash2 size={14} />
        </button>
      </div>

      <div className="card">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="section-title">Weekly hours</span>
          <span className="text-xs text-muted">{fmtHours(totalSeconds / 3600)} total</span>
        </div>
        <WeeklyBars data={weekly} color={color} />
      </div>

      <div className="card">
        <div className="section-title mb-2">Percent history</div>
        <Sparkline points={sparkPoints} height={48} color={color ?? "var(--accent)"} />
      </div>

      <div className="card">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="section-title">
            Sessions <span className="text-muted">({nodeSessions.length})</span>
          </span>
          <button className="btn btn-sm" onClick={() => setLogOpen(true)} title="Record hours worked away from the timer">
            <CalendarPlus size={12} /> Log time
          </button>
        </div>
        {nodeSessions.length === 0 ? (
          <div className="text-xs text-muted">No sessions yet. Already put hours into this? Use Log time.</div>
        ) : (
          <ul className="flex max-h-72 flex-col divide-y divide-[var(--border)] overflow-y-auto text-sm">
            {nodeSessions.slice(0, 100).map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-1.5">
                <div className="w-28 shrink-0 text-xs text-muted">{fromIso(s.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                <div className="w-16 shrink-0 tabular-nums">{fmtDuration(s.actual_seconds)}</div>
                <span className={cn("shrink-0 text-[10px]", s.ended_reason === "completed" ? "text-ok" : s.ended_reason === "aborted_credited" ? "text-warn" : "text-muted")}>
                  {s.ended_reason === "completed" ? "done" : s.ended_reason === "aborted_credited" ? "partial" : "discarded"}
                </span>
                {s.node_id !== node.id && <span className="truncate text-[10px] text-muted">{nodes.find((n) => n.id === s.node_id)?.name}</span>}
                <input
                  className="input min-w-0 flex-1 py-0.5 text-xs"
                  placeholder="note"
                  key={s.id + (s.note ?? "")}
                  defaultValue={s.note ?? ""}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== s.note) updateSessionNote(s.id, v);
                  }}
                />
                <button className="btn btn-ghost btn-sm text-muted" title="Delete session" onClick={() => deleteSession(s.id)}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <LogTimeDialog open={logOpen} onOpenChange={setLogOpen} nodeId={node.id} />
    </div>
  );
}

function fmtEff(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function StatusPill({ status }: { status: string }) {
  const cls = status === "Done" ? "text-ok" : status === "In progress" ? "text-accent" : "text-muted";
  return <span className={cn("pill", cls)}>{status}</span>;
}

function WeeklyBars({ data, color }: { data: { week: string; hours: number }[]; color: string | null }) {
  const max = Math.max(1, ...data.map((d) => d.hours));
  return (
    <div className="flex h-20 items-end gap-1.5">
      {data.map((d) => (
        <div key={d.week} className="flex flex-1 flex-col items-center gap-1" title={`${d.week}: ${fmtHours(d.hours)}`}>
          <div className="progress-fill w-full rounded-t bg-panel-2" style={{ height: `${Math.max(2, (d.hours / max) * 60)}px`, background: d.hours > 0 ? color ?? "var(--accent)" : undefined }} />
          <span className="whitespace-nowrap text-[9px] text-muted">{d.week.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
