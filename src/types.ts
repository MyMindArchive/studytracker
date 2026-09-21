export type Unit = "hours" | "pages" | "problems" | "chapters" | string;

/**
 * How a parent's percent is derived from its children.
 *  equal  — every direct child counts the same (a group counts once, however many leaves it holds)
 *  weight — every direct child counts `weight` times (default 1, so it starts out equal)
 *  effort — leaf tasks count by estimated effort (10h at 50% outweighs 1h at 100%)
 */
export type RollupMode = "equal" | "weight" | "effort";
export const ROLLUP_MODES: RollupMode[] = ["equal", "weight", "effort"];

/**
 * An explicit state that the percent cannot express. Percent already says
 * not-started / in-progress / done, so this only carries what it cannot:
 * work that is waiting on something outside your control. NULL means "read it
 * off the percent", which is what every node is until you say otherwise.
 */
export type NodeStatus = "blocked";

/**
 * How much this matters, set by hand. Deliberately stored as a number rather
 * than a word: the whole point of the field is ordering, and an integer orders
 * itself — 'emergency' < 'high' < 'low' is what a text column would give you,
 * so every query and every comparator would need a lookup table to undo it.
 *
 * The ranks are spaced by ten so a level can be slipped in between later
 * (a 35 between High and Urgent) without rewriting every row — and without
 * invalidating backups and CSV exports already sitting in someone's folder.
 * NULL means nothing was said, which is not the same as "low".
 */
export type Priority = "low" | "medium" | "high" | "urgent" | "emergency";

export interface PriorityLevel {
  id: Priority;
  /** stored value; higher is more important */
  rank: number;
  label: string;
  /** single letter for the tree chip, where there is no room for a word */
  short: string;
  color: string;
}

/** Ordered least to most important. */
export const PRIORITY_LEVELS: PriorityLevel[] = [
  { id: "low", rank: 10, label: "Low", short: "L", color: "#64748b" },
  { id: "medium", rank: 20, label: "Medium", short: "M", color: "#0ea5e9" },
  { id: "high", rank: 30, label: "High", short: "H", color: "#f59e0b" },
  { id: "urgent", rank: 40, label: "Urgent", short: "U", color: "#f97316" },
  { id: "emergency", rank: 50, label: "Emergency", short: "E", color: "#ef4444" },
];

export const PRIORITIES: Priority[] = PRIORITY_LEVELS.map((p) => p.id);

/** Lowest and highest stored ranks the CHECK constraint will accept. */
export const PRIORITY_MIN_RANK = 1;
export const PRIORITY_MAX_RANK = 100;

const BY_ID = new Map(PRIORITY_LEVELS.map((p) => [p.id, p]));

export function priorityRank(id: Priority | null | undefined): number | null {
  return id ? (BY_ID.get(id)?.rank ?? null) : null;
}

/**
 * The level a stored rank displays as. Anything in between two levels reads as
 * the lower of the two, so a hand-edited CSV or a file written by a later
 * version that knows more levels still shows something sensible instead of
 * dropping the value on the floor.
 */
export function priorityOfRank(rank: number | null | undefined): PriorityLevel | null {
  if (rank === null || rank === undefined || !Number.isFinite(Number(rank))) return null;
  const n = Number(rank);
  let out: PriorityLevel | null = null;
  for (const lvl of PRIORITY_LEVELS) {
    if (n >= lvl.rank) out = lvl;
  }
  return out ?? PRIORITY_LEVELS[0];
}

/** Clamp an arbitrary number into the range the column accepts; null passes through. */
export function clampPriority(rank: number | null | undefined): number | null {
  if (rank === null || rank === undefined || rank === ("" as unknown)) return null;
  const n = Number(rank);
  if (!Number.isFinite(n)) return null;
  return Math.max(PRIORITY_MIN_RANK, Math.min(PRIORITY_MAX_RANK, Math.round(n)));
}

/** Accepts a level name ("high") or a rank ("30"); anything else is null. */
export function parsePriority(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return clampPriority(v);
  const s = String(v).trim().toLowerCase();
  const byName = BY_ID.get(s as Priority);
  if (byName) return byName.rank;
  return clampPriority(Number(s));
}

export interface DbNode {
  id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  sort_order: number;
  est_effort: number | null;
  pct_complete: number;
  deadline: string | null;
  /** the day work was meant to begin; drives the "should have started" flag */
  planned_start: string | null;
  /** null = derive from pct_complete; "blocked" = waiting on something */
  status: NodeStatus | null;
  /** stored priority rank (see PRIORITY_LEVELS); null = none set */
  priority: number | null;
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

/**
 * Where a session came from. This is not bookkeeping for its own sake: a block
 * you sat through and a block you typed in afterwards are worth different
 * things. Only a timer block can be said to have run to the end, and only a
 * timer block knows what hour of the day it really happened at.
 *
 *  timer     the countdown wrote it
 *  manual    typed into Log time, for work already done
 *  imported  came in from a file
 *  unknown   written before the app recorded this (schema v3 and earlier)
 */
export type SessionSource = "timer" | "manual" | "imported" | "unknown";
export const SESSION_SOURCES: SessionSource[] = ["timer", "manual", "imported", "unknown"];
/** Sources whose start time is a real clock reading rather than something typed. */
export const CLOCK_SOURCES: SessionSource[] = ["timer", "unknown"];

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
  source: SessionSource;
  /** minutes east of UTC when it was recorded; null for rows written before v4 */
  tz_offset: number | null;
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

/** One status transition. Blocked time is the gap between two of these rows. */
export interface StatusHistory {
  id: string;
  node_id: string;
  /** null = back to being read off the percent */
  status: NodeStatus | null;
  changed_at: string;
  note: string | null;
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

export type SkinId = "clean" | "terminal" | "soft" | "press";

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
