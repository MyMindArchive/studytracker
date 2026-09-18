export type Unit = "hours" | "pages" | "problems" | "chapters" | string;

/**
 * How a parent's percent is derived from its children.
 *  equal  — every direct child counts the same (a group counts once, however many leaves it holds)
 *  weight — every direct child counts `weight` times (default 1, so it starts out equal)
 *  effort — leaf tasks count by estimated effort (10h at 50% outweighs 1h at 100%)
 */
export type RollupMode = "equal" | "weight" | "effort";
export const ROLLUP_MODES: RollupMode[] = ["equal", "weight", "effort"];

export interface DbNode {
  id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  sort_order: number;
  est_effort: number | null;
  pct_complete: number;
  deadline: string | null;
  created_at: string;
  updated_at: string;
  /** share among siblings, used when the parent rolls up by weight */
  weight: number;
  /** roll-up rule for this node's children; null inherits from the parent (or the setting at root) */
  rollup_mode: RollupMode | null;
  // subject-level fields (parent_id === null)
  unit: string | null;
  hours_per_unit: number | null;
  weekly_target_hours: number | null;
  color: string | null;
}

export type SessionMode = "single" | "cycle";
export type EndedReason = "completed" | "aborted_credited" | "aborted_discarded";

export interface Session {
  id: string;
  node_id: string | null;
  cycle_id: string | null;
  mode: SessionMode;
  planned_seconds: number;
  actual_seconds: number;
  started_at: string;
  ended_at: string;
  ended_reason: EndedReason;
  note: string | null;
}

/** One tick box under a leaf task. Items count equally toward the task's percent. */
export interface ChecklistItem {
  id: string;
  node_id: string;
  label: string;
  done: boolean;
  sort_order: number;
  created_at: string;
}

export interface PctHistory {
  id: string;
  node_id: string;
  pct: number;
  changed_at: string;
}

export interface CycleDefaults {
  workMinutes: number;
  breakMinutes: number;
  rounds: number;
  longBreakEvery: number;
  longBreakMinutes: number;
}

export type SkinId = "clean" | "terminal" | "soft";

/** A user-supplied file kept inline as a data: URL so both runtimes can use it. */
export interface MediaAsset {
  name: string;
  /** data:<mime>;base64,… */
  data: string;
}

export type OverlayTone = "dark" | "light";
/** backdrop resolution cap: 1080p = 1920 px, 2k = 2560 px on the longest side */
export type BackgroundQuality = "1080p" | "2k";

export interface Settings {
  daily_target_hours: number;
  storage_path: string;
  timer_presets: number[]; // minutes
  cycle_defaults: CycleDefaults;
  theme: "system" | "light" | "dark";
  skin: SkinId;
  sound: boolean;
  unassigned_badge_threshold_hours: number;
  csv_mirror: boolean;
  /** default roll-up rule for nodes that do not set their own */
  rollup_mode: RollupMode;
  /** focus screen backdrop; null = plain panel */
  timer_background: MediaAsset | null;
  /** translucent wash over the backdrop, 0..0.9 */
  timer_overlay: number;
  timer_overlay_tone: OverlayTone;
  /** resolution the backdrop is shrunk to when chosen */
  timer_background_quality: BackgroundQuality;
  /** custom end-of-block sound; null = built-in chime */
  bell: MediaAsset | null;
}

export const DEFAULT_SETTINGS: Settings = {
  daily_target_hours: 4,
  storage_path: "",
  timer_presets: [25, 50, 90],
  cycle_defaults: {
    workMinutes: 25,
    breakMinutes: 5,
    rounds: 4,
    longBreakEvery: 4,
    longBreakMinutes: 15,
  },
  theme: "system",
  skin: "clean",
  sound: true,
  unassigned_badge_threshold_hours: 1,
  csv_mirror: true,
  rollup_mode: "equal",
  timer_background: null,
  timer_overlay: 0.45,
  timer_overlay_tone: "dark",
  timer_background_quality: "2k",
  bell: null,
};

export const SUBJECT_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#f97316",
  "#84cc16",
];
