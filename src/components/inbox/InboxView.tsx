import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { useApp } from "../../store/app";
import { NodePicker } from "../ui/NodePicker";
import { fmtDuration, fmtHours, fromIso } from "../../lib/time";
import { unassignedHours } from "../../lib/stats";
import { cn } from "../../lib/cn";

export function InboxView() {
  const sessions = useApp((s) => s.sessions);
  const threshold = useApp((s) => s.settings.unassigned_badge_threshold_hours);
  const assign = useApp((s) => s.assignSessions);
  const updateNote = useApp((s) => s.updateSessionNote);
  const deleteSession = useApp((s) => s.deleteSession);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);

  const unassigned = useMemo(() => sessions.filter((s) => !s.node_id), [sessions]);
  const hours = unassignedHours(sessions);
  const allSelected = unassigned.length > 0 && unassigned.every((s) => selected.has(s.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex h-full flex-col">
      <header className="panel-head flex items-center gap-4 whitespace-nowrap px-5 py-3">
        <div className="shrink-0">
          <div className="h1 text-lg">Unassigned inbox</div>
          <div className={cn("text-xs", hours > threshold ? "text-warn" : "text-muted")}>
            {unassigned.length} session{unassigned.length === 1 ? "" : "s"} · {fmtHours(hours)} untagged
            {hours > threshold && ` · over the ${threshold}h badge threshold`}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted">{selected.size} selected →</span>
          <NodePicker value={target} onChange={setTarget} emptyLabel="choose target task" className="input w-64" />
          <button
            className="btn btn-primary"
            disabled={!target || selected.size === 0}
            onClick={async () => {
              await assign([...selected], target);
              setSelected(new Set());
            }}
          >
            Assign selected
          </button>
        </div>
      </header>

      {unassigned.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">Inbox zero. Every logged minute is tagged.</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="table-head sticky top-0 bg-app text-left">
              <tr>
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(unassigned.map((s) => s.id)))}
                    aria-label="Select all"
                  />
                </th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Duration</th>
                <th className="px-2 py-2">Mode</th>
                <th className="px-2 py-2">Note</th>
                <th className="px-2 py-2">Assign to</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {unassigned.map((s) => (
                <tr key={s.id} className={cn("border-t border-app", selected.has(s.id) && "bg-panel-2")}>
                  <td className="px-4 py-1.5">
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                  </td>
                  <td className="px-2 py-1.5 text-muted">{fromIso(s.started_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {fmtDuration(s.actual_seconds)}
                    <span className="ml-1 text-[10px] text-muted">{s.ended_reason === "completed" ? "" : s.ended_reason === "aborted_credited" ? "partial" : "discarded"}</span>
                  </td>
                  <td className="px-2 py-1.5 text-muted">{s.mode}</td>
                  <td className="px-2 py-1.5">
                    <input
                      className="input w-full py-0.5"
                      placeholder="add a note"
                      key={s.id + (s.note ?? "")}
                      defaultValue={s.note ?? ""}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        if (v !== s.note) updateNote(s.id, v);
                      }}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <NodePicker value={null} onChange={(id) => id && assign([s.id], id)} emptyLabel="pick task…" className="input w-56 py-0.5" />
                  </td>
                  <td className="px-2 py-1.5">
                    <button className="btn btn-ghost btn-sm text-muted" title="Delete session" onClick={() => deleteSession(s.id)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
