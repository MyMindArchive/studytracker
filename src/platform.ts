/**
 * Thin platform layer. In Tauri we use the native plugins; in a plain browser
 * (vite dev / tests) we degrade to downloads and the Notification API.
 */
import { isTauri } from "./db/driver";

export { isTauri };

export const STORAGE_PATH_KEY = "studytracker.storage_path";

export async function homeDir(): Promise<string> {
  if (!isTauri()) return "~";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("home_dir");
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
}

/** Join with the separator the first segment already uses (Windows keeps backslashes). */
export function joinPath(...parts: string[]): string {
  const segs = parts.filter(Boolean);
  const sep = segs[0] && (segs[0].includes("\\") || /^[A-Za-z]:/.test(segs[0])) && !segs[0].includes("/") ? "\\" : "/";
  return segs.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).join(sep);
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, multiple: false, defaultPath, title: "Choose StudyTracker data folder" });
  return typeof res === "string" ? res : null;
}

export async function pickOpenFile(filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, filters });
  return typeof res === "string" ? res : null;
}

/** Several files at once (a CSV restore takes the whole mirror). */
export async function pickOpenFiles(filters: { name: string; extensions: string[] }[]): Promise<string[]> {
  if (!isTauri()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: true, filters });
  return Array.isArray(res) ? res : typeof res === "string" ? [res] : [];
}

export async function pickSaveFile(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters });
}

export async function fileExists(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  const fs = await import("@tauri-apps/plugin-fs");
  return fs.exists(path);
}

export async function ensureDir(path: string): Promise<void> {
  if (!isTauri()) return;
  const fs = await import("@tauri-apps/plugin-fs");
  if (!(await fs.exists(path))) await fs.mkdir(path, { recursive: true });
}

export async function writeText(path: string, text: string): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeTextFile(path, text);
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeFile(path, bytes);
}

export async function readText(path: string): Promise<string> {
  const fs = await import("@tauri-apps/plugin-fs");
  return fs.readTextFile(path);
}

export async function readBytes(path: string): Promise<Uint8Array> {
  const fs = await import("@tauri-apps/plugin-fs");
  return fs.readFile(path);
}

export function downloadBlob(name: string, data: Uint8Array | string, mime = "application/octet-stream"): void {
  const blob = data instanceof Uint8Array ? new Blob([data as BlobPart], { type: mime }) : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save bytes: native save dialog in Tauri, download in the browser. Returns the path or null. */
export async function saveBytes(defaultName: string, bytes: Uint8Array, ext: string, mime: string): Promise<string | null> {
  if (isTauri()) {
    const path = await pickSaveFile(defaultName, [{ name: ext.toUpperCase(), extensions: [ext] }]);
    if (!path) return null;
    await writeBytes(path, bytes);
    return path;
  }
  downloadBlob(defaultName, bytes, mime);
  return defaultName;
}

export async function openPath(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

let notifyPermission: boolean | null = null;
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (isTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      if (notifyPermission === null) {
        notifyPermission = await n.isPermissionGranted();
        if (!notifyPermission) notifyPermission = (await n.requestPermission()) === "granted";
      }
      if (notifyPermission) n.sendNotification({ title, body });
      return;
    }
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    }
  } catch (e) {
    console.warn("notification failed", e);
  }
}

export async function backupDatabase(dbPath: string, keep = 7): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("backup_database", { dbPath, keep });
}

/** Consistent copy of the live database (VACUUM INTO). Refuses to overwrite. */
export async function copyDatabase(srcPath: string, dstPath: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("copy_database", { srcPath, dstPath });
}

/** Whatever is currently sounding, so it can be cut short. */
let currentChime: { stop: () => void } | null = null;

/** True while a bell or chime is still sounding. */
export function isChimePlaying(): boolean {
  return currentChime !== null;
}

/** Cut the bell short (no-op when nothing is playing). */
export function stopChime(): void {
  const c = currentChime;
  currentChime = null;
  c?.stop();
}

/**
 * Plays the custom bell when one is set, else the built-in three-note chime.
 * Only one sound plays at a time; `onEnd` fires when it finishes on its own
 * or is stopped with `stopChime()`.
 */
export function playChime(custom?: string | null, onEnd?: () => void): void {
  stopChime();
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (currentChime === handle) currentChime = null;
    onEnd?.();
  };
  let handle: { stop: () => void } = { stop: finish };

  if (custom) {
    try {
      const a = new Audio(custom);
      a.volume = 0.9;
      a.onended = finish;
      a.onerror = finish;
      handle = {
        stop: () => {
          a.onended = null;
          a.onerror = null;
          a.pause();
          a.src = "";
          finish();
        },
      };
      currentChime = handle;
      a.play().catch(() => {
        // autoplay refused or bad file: fall back to the synth chime
        if (currentChime === handle) currentChime = null;
        ended = true;
        playChime(null, onEnd);
      });
      return;
    } catch {
      /* fall through to the synth chime */
    }
  }
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = [880, 1108.73, 1318.51];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.value = 0.0001;
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.start(t);
      o.stop(t + 0.55);
    });
    const timer = setTimeout(() => handle.stop(), 1500);
    handle = {
      stop: () => {
        clearTimeout(timer);
        ctx.close().catch(() => {});
        finish();
      },
    };
    currentChime = handle;
  } catch {
    finish();
  }
}
