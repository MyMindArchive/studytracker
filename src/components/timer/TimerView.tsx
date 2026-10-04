import { useEffect, useMemo, useState } from "react";
import { Bell, BellOff, Check, Pause, Play, Plus, Square, SkipForward, X } from "lucide-react";
import { useApp } from "../../store/app";
import { COUNTUP_MAX_SECONDS, TIMER_MODES, useTimer } from "../../store/timer";
import { NodePicker } from "../ui/NodePicker";
import { Modal } from "../ui/Modal";
import { Field, NumberInput } from "../ui/Field";
import { fmtClock, fmtDuration } from "../../lib/time";
import { cn } from "../../lib/cn";
import { Dial } from "./Dial";
import { subjectIndex } from "../../lib/rollup";
import { dataUrlToObjectUrl } from "../../lib/media";
import { upNext } from "../../lib/focus";
import { relativeDue } from "../../lib/time";
import { priorityOfRank } from "../../types";

export function TimerView() {
  const t = useTimer();
  const presets = useApp((s) => s.settings.timer_presets);
  const backdrop = useApp((s) => s.settings.timer_background);
  const overlay = useApp((s) => s.settings.timer_overlay);
  const tone = useApp((s) => s.settings.timer_overlay_tone);
  const nodes = useApp((s) => s.nodes);
  // A blob: URL keeps the (possibly large) data: URL out of the DOM; revoked when it changes.
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!backdrop) {
      setBgUrl(null);
      return;
    }
    const url = dataUrlToObjectUrl(backdrop.data);
    setBgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [backdrop]);
  const remaining = t.remaining();
  const countUp = t.mode === "countup";
  const elapsed = t.elapsed();
  const running = t.phase === "running";
  const idle = t.phase === "idle";
  const isBreak = t.blockKind !== "work";
  const node = nodes.find((n) => n.id === t.nodeId);
  const subject = node ? subjectIndex(nodes).get(node.id) : undefined;
  const color = isBreak ? "var(--ok)" : subject?.color ?? "var(--accent)";
  // The dial draws what is left; a count-up has no end, so its arc grows through each hour instead.
  const progress = idle ? (countUp ? 1 : 0) : countUp ? 1 - (elapsed % 3600) / 3600 : 1 - remaining / Math.max(1, t.plannedSeconds);

  // Re-render every 250ms while running via tick subscription
  void t.tick;

  const [minutesDraft, setMinutesDraft] = useState<string | null>(null);
  useEffect(() => setMinutesDraft(null), [t.singleMinutes]);

  const endsAt = running && t.endsAt ? new Date(t.endsAt) : null;
  const stateLabel = idle
    ? countUp
      ? `count up · max ${COUNTUP_MAX_SECONDS / 3600} h`
      : t.mode === "single"
      ? `${t.singleMinutes} min`
      : `${t.cycle.rounds} rounds · ${t.cycle.workMinutes} / ${t.cycle.breakMinutes} min`
    : isBreak
      ? t.blockKind === "longbreak"
        ? "long break"
        : "break"
      : t.phase === "paused"
        ? "paused"
        : node
          ? node.name
          : "focus";

  return (
    <div className="timer-stage" data-tone={bgUrl ? tone : undefined} style={{ "--stage-overlay": overlay } as React.CSSProperties}>
      {bgUrl && <div className="timer-stage-bg" style={{ backgroundImage: `url("${bgUrl}")` }} aria-hidden />}
    <div className="timer-stage-content flex h-full flex-col items-center overflow-y-auto px-6 py-6">
      {/* mode toggle */}
      <div className="seg seg-lg">
        {TIMER_MODES.map((m) => (
          <button key={m.id} disabled={!idle} onClick={() => t.setMode(m.id)} className="seg-item" data-active={t.mode === m.id}>
            {m.label}
          </button>
        ))}
      </div>

      {/* ring + digits */}
      <div className="relative mt-6">
        <Dial size={320} progress={progress} color={color} interactive={idle && t.mode === "single"} minutes={t.singleMinutes} onMinutes={(m) => t.setSingleMinutes(m)} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className={cn("timer-digits text-[76px]", t.phase === "paused" && "opacity-50")}>{fmtClock(countUp ? Math.min(COUNTUP_MAX_SECONDS, elapsed) : remaining)}</div>
          <div className="mt-2 max-w-[200px] truncate text-xs uppercase tracking-[0.2em] text-muted">{stateLabel}</div>
          {endsAt && !countUp && (
            <div className="mt-2 flex items-center gap-1 text-sm text-muted">
              <Bell size={13} /> {endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
          {t.mode === "cycle" && !idle && (
            <div className="mt-3 flex items-center gap-1.5" aria-label={`Round ${t.round} of ${t.cycle.rounds}`}>
              {Array.from({ length: t.cycle.rounds }, (_, i) => (
                <span key={i} className="round-dot" data-state={i + 1 < t.round || (i + 1 === t.round && isBreak) ? "done" : i + 1 === t.round ? "current" : "todo"} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* duration controls */}
      {idle && t.mode === "single" && (
        <div className="mt-5 flex items-center gap-2">
          {presets.map((p) => (
            <button key={p} className={cn("btn btn-sm rounded-full px-3", t.singleMinutes === p && "btn-primary")} onClick={() => t.setSingleMinutes(p)}>
              {p} min
            </button>
          ))}
          <input
            type="number"
            min={1}
            max={600}
            className="input w-20 text-right"
            value={minutesDraft ?? t.singleMinutes}
            onChange={(e) => setMinutesDraft(e.target.value)}
            onBlur={() => {
              if (minutesDraft !== null) t.setSingleMinutes(Number(minutesDraft) || t.singleMinutes);
              setMinutesDraft(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Minutes"
          />
          <span className="text-sm text-muted">min</span>
        </div>
      )}
      {idle && t.mode === "cycle" && (
        <div className="card mt-5 grid grid-cols-5 gap-3">
          <Field label="Work" hint="min">
            <NumberInput value={t.cycle.workMinutes} min={1} step={1} className="input w-full" onChange={(v) => t.setCycle({ workMinutes: Math.max(1, v ?? 1) })} />
          </Field>
          <Field label="Break" hint="min">
            <NumberInput value={t.cycle.breakMinutes} min={0} step={1} className="input w-full" onChange={(v) => t.setCycle({ breakMinutes: Math.max(0, v ?? 0) })} />
          </Field>
          <Field label="Rounds">
            <NumberInput value={t.cycle.rounds} min={1} step={1} className="input w-full" onChange={(v) => t.setCycle({ rounds: Math.max(1, Math.round(v ?? 1)) })} />
          </Field>
          <Field label="Long break every" hint="rounds">
            <NumberInput value={t.cycle.longBreakEvery} min={0} step={1} className="input w-full" onChange={(v) => t.setCycle({ longBreakEvery: Math.max(0, Math.round(v ?? 0)) })} />
          </Field>
          <Field label="Long break" hint="min">
            <NumberInput value={t.cycle.longBreakMinutes} min={0} step={1} className="input w-full" onChange={(v) => t.setCycle({ longBreakMinutes: Math.max(0, v ?? 0) })} />
          </Field>
        </div>
      )}

      {/* tag */}
      <div className="mt-5 flex w-full max-w-md items-center gap-2">
        <span className="text-xs text-muted">Tag</span>
        <NodePicker value={t.nodeId} onChange={t.setNode} emptyLabel="— untagged (goes to inbox) —" className="input flex-1" upNextFirst />
      </div>
      <UpNext selected={t.nodeId} onPick={t.setNode} />

      {/* controls */}
      <div className="mt-7 flex items-center gap-6">
        {idle ? (
          <button className="round-btn" style={{ "--tint": "var(--ok)" } as React.CSSProperties} onClick={t.start}>
            <Play size={18} />
            <span>Start</span>
          </button>
        ) : (
          <>
            <button className="round-btn" style={{ "--tint": "var(--danger)" } as React.CSSProperties} onClick={t.requestAbort}>
              {isBreak ? <X size={18} /> : <Square size={16} />}
              <span>{isBreak ? "End" : "Abort"}</span>
            </button>
            {countUp ? (
              <button className="round-btn" style={{ "--tint": "var(--ok)" } as React.CSSProperties} onClick={t.finish} title="Stop and log the time counted">
                <Check size={18} />
                <span>Finish</span>
              </button>
            ) : (
            <div className="flex items-center gap-2">
              <button className="btn btn-sm rounded-full px-3" onClick={() => t.extend(5)}>
                <Plus size={12} /> 5
              </button>
              <button className="btn btn-sm rounded-full px-3" onClick={() => t.extend(10)}>
                <Plus size={12} /> 10
              </button>
              {isBreak && (
                <button className="btn btn-sm rounded-full px-3" onClick={t.skipBreak}>
                  <SkipForward size={12} /> Skip
                </button>
              )}
            </div>
            )}
            <button className="round-btn" style={{ "--tint": running ? "var(--warn)" : "var(--ok)" } as React.CSSProperties} onClick={running ? t.pause : t.resume}>
              {running ? <Pause size={18} /> : <Play size={18} />}
              <span>{running ? "Pause" : "Resume"}</span>
            </button>
          </>
        )}
      </div>
      <p className="mt-4 text-xs text-muted">
        <span className="kbd">space</span> start / pause · {countUp ? `logged when you finish · stops by itself at ${COUNTUP_MAX_SECONDS / 3600} h` : `elapsed ${fmtDuration(elapsed)}`}
      </p>
      {t.alarmPlaying && (
        <button className="btn btn-primary mt-3 rounded-full px-4" onClick={t.stopAlarm} title="Stop the bell (Esc)">
          <BellOff size={14} /> Stop sound
        </button>
      )}

      {/* abort dialog */}
      <Modal
        open={t.abortPrompt}
        onOpenChange={(o) => !o && t.cancelAbort()}
        title="Abort this session?"
        description={countUp ? `You have counted ${fmtDuration(t.elapsed())}. Log that time or discard it?` : `You've studied for ${fmtDuration(t.elapsed())} of ${fmtDuration(t.plannedSeconds)}. Credit that time or discard it?`}
        footer={
          <>
            <button className="btn" onClick={t.cancelAbort}>
              Keep going
            </button>
            <button className="btn btn-danger" onClick={() => t.confirmAbort(false)}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={() => t.confirmAbort(true)}>
              Credit {fmtDuration(t.elapsed())}
            </button>
          </>
        }
      />

      {/* untagged prompt */}
      <TagPrompt />
    </div>
    </div>
  );
}

function TagPrompt() {
  const pending = useTimer((s) => s.tagPrompt);
  const resolve = useTimer((s) => s.resolveTagPrompt);
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => setChoice(null), [pending]);
  return (
    <Modal
      open={pending !== null}
      onOpenChange={(o) => !o && resolve(null)}
      title="Tag this session?"
      description={pending ? `${fmtDuration(pending.actual_seconds)} is about to be saved without a task. Pick one now or leave it in the inbox.` : undefined}
      footer={
        <>
          <button className="btn" onClick={() => resolve(null)}>
            Skip
          </button>
          <button className="btn btn-primary" disabled={!choice} onClick={() => resolve(choice)}>
            Assign
          </button>
        </>
      }
    >
      <NodePicker value={choice} onChange={setChoice} className="input w-full" autoFocus />
    </Modal>
  );
}

/** The top of the Focus order, one click from being the next block's task. */
function UpNext({ selected, onPick }: { selected: string | null; onPick: (id: string) => void }) {
  const nodes = useApp((s) => s.nodes);
  const rollup = useApp((s) => s.rollup);
  const dailyTarget = useApp((s) => s.settings.daily_target_hours);
  const setView = useApp((s) => s.setView);
  const items = useMemo(() => upNext({ nodes, rollup, dailyTargetHours: dailyTarget, today: new Date() }), [nodes, rollup, dailyTarget]);
  if (items.length === 0) return null;
  return (
    <div className="card mt-3 w-full max-w-md p-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="table-head">Up next</span>
        <button className="text-[11px] text-muted hover:text-fg" onClick={() => setView("focus")}>
          See all →
        </button>
      </div>
      {items.map((i) => {
        const lvl = priorityOfRank(i.priority);
        const due = i.deadline ? relativeDue(i.deadline) : null;
        const active = selected === i.node.id;
        return (
          <button
            key={i.node.id}
            className={cn("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-[var(--panel-2)]", active && "bg-[var(--sel)]")}
            onClick={() => onPick(i.node.id)}
            title={`Tag the timer with ${i.node.name}`}
            aria-pressed={active}
          >
            <span className="dot h-2 w-2 shrink-0" style={{ background: i.subject.color ?? "var(--accent)" }} />
            <span className="min-w-0 flex-1 truncate">
              {i.node.name}
              <span className="ml-2 text-xs text-muted">{i.subject.id === i.node.id ? "" : i.subject.name}</span>
            </span>
            {lvl && (
              <span className="chip shrink-0 font-medium" style={{ color: "#fff", borderColor: lvl.color, background: lvl.color }} title={lvl.label}>
                {lvl.short}
              </span>
            )}
            {due && (
              <span className="due w-16 shrink-0 text-right" data-tone={due.tone}>
                {due.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
