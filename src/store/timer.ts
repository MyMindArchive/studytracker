import { create } from "zustand";
import type { CycleDefaults, Session } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { uid } from "../lib/ids";
import { notify, playChime, stopChime } from "../platform";
import { useApp } from "./app";

export type BlockKind = "work" | "break" | "longbreak";
export type Phase = "idle" | "running" | "paused";

type PendingSession = Omit<Session, "id">;

interface TimerState {
  mode: "single" | "cycle";
  singleMinutes: number;
  cycle: CycleDefaults;
  nodeId: string | null;

  phase: Phase;
  blockKind: BlockKind;
  plannedSeconds: number;
  /** wall clock ms at which the current block ends (running only) */
  endsAt: number | null;
  remainingAtPause: number;
  blockStartedAt: string | null;
  /** seconds accumulated in previous run segments of this block */
  elapsedBefore: number;
  runningSince: number | null;

  cycleId: string | null;
  round: number;
  askedTagThisRun: boolean;

  abortPrompt: boolean;
  tagPrompt: PendingSession | null;
  tick: number;
  /** the end-of-block bell is still sounding */
  alarmPlaying: boolean;

  setMode(m: "single" | "cycle"): void;
  setSingleMinutes(m: number): void;
  setCycle(c: Partial<CycleDefaults>): void;
  setNode(id: string | null): void;
  loadDefaults(): void;

  start(): void;
  pause(): void;
  resume(): void;
  toggle(): void;
  extend(minutes: number): void;
  requestAbort(): void;
  cancelAbort(): void;
  confirmAbort(credit: boolean): void;
  skipBreak(): void;
  stopCycle(): void;
  resolveTagPrompt(nodeId: string | null): void;
  /** cut the end-of-block bell short */
  stopAlarm(): void;

  remaining(): number;
  elapsed(): number;
}

let interval: ReturnType<typeof setInterval> | null = null;

export const useTimer = create<TimerState>((set, get) => {
  const clearTicker = () => {
    if (interval) clearInterval(interval);
    interval = null;
  };

  const startTicker = () => {
    clearTicker();
    interval = setInterval(() => {
      const s = get();
      if (s.phase !== "running" || s.endsAt === null) return;
      if (Date.now() >= s.endsAt) completeBlock();
      else set({ tick: s.tick + 1 });
    }, 250);
  };

  const beginBlock = (kind: BlockKind, seconds: number) => {
    const now = Date.now();
    set({
      phase: "running",
      blockKind: kind,
      plannedSeconds: seconds,
      endsAt: now + seconds * 1000,
      remainingAtPause: 0,
      blockStartedAt: new Date(now).toISOString(),
      elapsedBefore: 0,
      runningSince: now,
    });
    startTicker();
  };

  const finishSession = (session: PendingSession) => {
    const s = get();
    if (session.node_id === null && !s.askedTagThisRun) {
      set({ tagPrompt: session, askedTagThisRun: true });
      return;
    }
    useApp
      .getState()
      .logSession(session)
      .catch((e) => useApp.getState().toast(`Failed to save session: ${e}`));
  };

  const buildSession = (reason: Session["ended_reason"], actual: number): PendingSession => {
    const s = get();
    return {
      node_id: s.nodeId,
      cycle_id: s.mode === "cycle" ? s.cycleId : null,
      mode: s.mode,
      planned_seconds: s.plannedSeconds,
      actual_seconds: Math.max(0, Math.round(actual)),
      started_at: s.blockStartedAt ?? new Date().toISOString(),
      ended_at: new Date().toISOString(),
      ended_reason: reason,
      note: null,
    };
  };

  /** Silence the bell and clear its toast, whether it ended by itself or was cut short. */
  let alarmToastId: string | null = null;
  const stopAlarm = () => {
    stopChime();
    if (get().alarmPlaying) set({ alarmPlaying: false });
    if (alarmToastId) {
      useApp.getState().dismissToast(alarmToastId);
      alarmToastId = null;
    }
  };

  const alertUser = (title: string, body: string) => {
    const app = useApp.getState();
    stopAlarm();
    if (app.settings.sound) {
      set({ alarmPlaying: true });
      playChime(app.settings.bell?.data, () => {
        // ended on its own: tidy up without touching a newer alarm's toast
        if (get().alarmPlaying) set({ alarmPlaying: false });
        if (alarmToastId) {
          app.dismissToast(alarmToastId);
          alarmToastId = null;
        }
      });
      // reachable from any view; the action also dismisses the toast
      alarmToastId = app.toast(`${title} · ${body}`, { label: "Stop sound", run: () => get().stopAlarm() }, 60_000);
    }
    notify(title, body);
  };

  const goIdle = () => {
    clearTicker();
    set({ phase: "idle", endsAt: null, runningSince: null, elapsedBefore: 0, remainingAtPause: 0, blockStartedAt: null, cycleId: null, round: 0, blockKind: "work" });
  };

  /** Called when the countdown reaches zero. */
  const completeBlock = () => {
    const s = get();
    clearTicker();
    if (s.blockKind === "work") {
      finishSession(buildSession("completed", s.plannedSeconds));
      if (s.mode === "single") {
        alertUser("Session complete", `${Math.round(s.plannedSeconds / 60)} minutes logged.`);
        goIdle();
        return;
      }
      // cycle: break or finish
      if (s.round >= s.cycle.rounds) {
        alertUser("Cycle complete", `${s.cycle.rounds} rounds done.`);
        goIdle();
        return;
      }
      const isLong = s.cycle.longBreakEvery > 0 && s.round % s.cycle.longBreakEvery === 0;
      const mins = isLong ? s.cycle.longBreakMinutes : s.cycle.breakMinutes;
      alertUser("Work block done", isLong ? `Long break: ${mins} min` : `Break: ${mins} min`);
      beginBlock(isLong ? "longbreak" : "break", Math.max(1, Math.round(mins * 60)));
      return;
    }
    // break finished -> next work round
    alertUser("Break over", `Round ${s.round + 1} of ${s.cycle.rounds}`);
    set({ round: s.round + 1 });
    beginBlock("work", Math.max(1, Math.round(s.cycle.workMinutes * 60)));
  };

  return {
    mode: "single",
    singleMinutes: 25,
    cycle: DEFAULT_SETTINGS.cycle_defaults,
    nodeId: null,
    phase: "idle",
    blockKind: "work",
    plannedSeconds: 25 * 60,
    endsAt: null,
    remainingAtPause: 0,
    blockStartedAt: null,
    elapsedBefore: 0,
    runningSince: null,
    cycleId: null,
    round: 0,
    askedTagThisRun: false,
    abortPrompt: false,
    tagPrompt: null,
    tick: 0,
    alarmPlaying: false,

    setMode: (mode) => get().phase === "idle" && set({ mode }),
    setSingleMinutes: (m) => set({ singleMinutes: Math.max(1, Math.min(600, Math.round(m))) }),
    setCycle: (c) => set((s) => ({ cycle: { ...s.cycle, ...c } })),
    setNode: (nodeId) => set({ nodeId }),
    loadDefaults() {
      const st = useApp.getState().settings;
      set({ cycle: st.cycle_defaults, singleMinutes: st.timer_presets[0] ?? 25 });
    },

    start() {
      const s = get();
      stopAlarm();
      if (s.phase !== "idle") return;
      set({ askedTagThisRun: false });
      if (s.mode === "single") {
        beginBlock("work", s.singleMinutes * 60);
      } else {
        set({ cycleId: uid(), round: 1 });
        beginBlock("work", Math.max(1, Math.round(s.cycle.workMinutes * 60)));
      }
    },

    pause() {
      const s = get();
      stopAlarm();
      if (s.phase !== "running" || s.endsAt === null) return;
      clearTicker();
      const now = Date.now();
      set({
        phase: "paused",
        remainingAtPause: Math.max(0, (s.endsAt - now) / 1000),
        elapsedBefore: s.elapsedBefore + (s.runningSince ? (now - s.runningSince) / 1000 : 0),
        runningSince: null,
        endsAt: null,
      });
    },

    resume() {
      const s = get();
      stopAlarm();
      if (s.phase !== "paused") return;
      const now = Date.now();
      set({ phase: "running", endsAt: now + s.remainingAtPause * 1000, runningSince: now });
      startTicker();
    },

    toggle() {
      const p = get().phase;
      if (p === "idle") get().start();
      else if (p === "running") get().pause();
      else get().resume();
    },

    extend(minutes) {
      const s = get();
      if (s.phase === "idle") return;
      const add = minutes * 60;
      if (s.phase === "running" && s.endsAt !== null) set({ endsAt: s.endsAt + add * 1000, plannedSeconds: s.plannedSeconds + add });
      else set({ remainingAtPause: s.remainingAtPause + add, plannedSeconds: s.plannedSeconds + add });
    },

    requestAbort() {
      const s = get();
      stopAlarm();
      if (s.phase === "idle") return;
      if (s.blockKind !== "work") {
        // aborting a break just ends the cycle; nothing to credit
        goIdle();
        return;
      }
      if (s.phase === "running") get().pause();
      set({ abortPrompt: true });
    },
    cancelAbort: () => set({ abortPrompt: false }),

    confirmAbort(credit) {
      const s = get();
      set({ abortPrompt: false });
      const elapsed = s.elapsedBefore; // paused, so all elapsed is accumulated
      finishSession(buildSession(credit ? "aborted_credited" : "aborted_discarded", credit ? elapsed : 0));
      goIdle();
    },

    skipBreak() {
      const s = get();
      stopAlarm();
      if (s.blockKind === "work") return;
      clearTicker();
      set({ round: s.round + 1 });
      beginBlock("work", Math.max(1, Math.round(s.cycle.workMinutes * 60)));
    },

    stopCycle() {
      goIdle();
    },

    resolveTagPrompt(nodeId) {
      const p = get().tagPrompt;
      if (!p) return;
      // closing the pop-up (Skip, Assign or Esc) also silences the bell
      stopAlarm();
      set({ tagPrompt: null });
      if (nodeId) set({ nodeId });
      useApp
        .getState()
        .logSession({ ...p, node_id: nodeId })
        .catch((e) => useApp.getState().toast(`Failed to save session: ${e}`));
    },

    stopAlarm,

    remaining() {
      const s = get();
      if (s.phase === "running" && s.endsAt !== null) return Math.max(0, (s.endsAt - Date.now()) / 1000);
      if (s.phase === "paused") return s.remainingAtPause;
      return s.mode === "single" ? s.singleMinutes * 60 : s.cycle.workMinutes * 60;
    },

    elapsed() {
      const s = get();
      if (s.phase === "running" && s.runningSince !== null) return s.elapsedBefore + (Date.now() - s.runningSince) / 1000;
      return s.elapsedBefore;
    },
  };
});
