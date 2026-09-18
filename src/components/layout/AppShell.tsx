import { useEffect } from "react";
import { BarChart3, Inbox, ListTree, Settings as SettingsIcon, Timer as TimerIcon } from "lucide-react";
import { useApp, type View } from "../../store/app";
import { useTimer } from "../../store/timer";
import { TreeView } from "../tree/TreeView";
import { TimerView } from "../timer/TimerView";
import { InboxView } from "../inbox/InboxView";
import { DashboardView } from "../dashboard/DashboardView";
import { SettingsView } from "../settings/SettingsView";
import { unassignedHours } from "../../lib/stats";
import { fmtClock } from "../../lib/time";
import { childrenOf } from "../../lib/rollup";
import { cn } from "../../lib/cn";

const NAV: { id: View; label: string; icon: typeof ListTree }[] = [
  { id: "tree", label: "Tree", icon: ListTree },
  { id: "timer", label: "Timer", icon: TimerIcon },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "dashboard", label: "Dashboard", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function isEditingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function AppShell() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const sessions = useApp((s) => s.sessions);
  const threshold = useApp((s) => s.settings.unassigned_badge_threshold_hours);
  const unassigned = unassignedHours(sessions);
  const showBadge = unassigned > threshold;

  const phase = useTimer((s) => s.phase);
  const tick = useTimer((s) => s.tick);
  const remaining = useTimer((s) => s.remaining)();
  void tick;

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (isEditingTarget(e.target)) return;
        e.preventDefault();
        useApp.getState().undo();
        return;
      }
      if (isEditingTarget(e.target) || meta) return;
      const app = useApp.getState();
      if (e.altKey) {
        // Alt+Up / Alt+Down: move the selected row among its siblings (manual order only)
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && app.view === "tree" && app.selectedNodeId) {
          e.preventDefault();
          if (app.treeSort !== "manual") {
            app.toast("Switch the tree to manual order to move rows");
            return;
          }
          const node = app.nodes.find((n) => n.id === app.selectedNodeId);
          if (!node) return;
          const sibs = childrenOf(app.nodes).get(node.parent_id) ?? [];
          const idx = sibs.findIndex((n) => n.id === node.id);
          const target = e.key === "ArrowUp" ? idx - 1 : idx + 1;
          if (target < 0 || target >= sibs.length) return;
          app.moveNode(node.id, node.parent_id, target);
        }
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        useTimer.getState().toggle();
        if (app.view !== "timer" && useTimer.getState().phase !== "idle") app.toast("Timer " + (useTimer.getState().phase === "running" ? "running" : "paused"));
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (app.view !== "tree") app.setView("tree");
        const sel = app.selectedNodeId;
        if (sel) app.addChild(sel);
        else app.addSubject();
      } else if (e.key.toLowerCase() === "e") {
        if (app.view === "tree" && app.selectedNodeId) {
          e.preventDefault();
          app.requestEditPct();
        }
      } else if (e.key === "Escape") {
        if (useTimer.getState().alarmPlaying) useTimer.getState().stopAlarm();
        else app.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Window title mirrors the countdown
  useEffect(() => {
    document.title = phase === "idle" ? "StudyTracker" : `${fmtClock(remaining)} · StudyTracker`;
  }, [phase, remaining]);

  return (
    <div className="flex h-full">
      <nav className="sidebar flex w-52 shrink-0 flex-col">
        <div className="px-4 pt-5 pb-3">
          <div className="brand text-sm">StudyTracker</div>
          <div className="text-[11px] text-muted">local-first</div>
        </div>
        <ul className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button onClick={() => setView(id)} className="nav-item" data-active={view === id} aria-current={view === id ? "page" : undefined}>
                <Icon size={16} />
                <span className="flex-1 text-left">{label}</span>
                {id === "inbox" && showBadge && (
                  <span className="badge">{unassigned.toFixed(1)}h</span>
                )}
                {id === "timer" && phase !== "idle" && (
                  <span className={cn("font-mono text-[11px]", phase === "paused" ? "text-muted" : "text-accent")}>{fmtClock(remaining)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-auto px-4 pb-4 text-[11px] text-muted leading-5">
          <div>
            <span className="kbd">space</span> start / pause
          </div>
          <div>
            <span className="kbd">N</span> new task
          </div>
          <div>
            <span className="kbd">E</span> edit percent
          </div>
          <div>
            <span className="kbd">⌘Z</span> undo
          </div>
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-hidden">
        {view === "tree" && <TreeView />}
        {view === "timer" && <TimerView />}
        {view === "inbox" && <InboxView />}
        {view === "dashboard" && <DashboardView />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
