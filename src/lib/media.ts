import { isTauri, pickOpenFile, readBytes } from "../platform";
import type { MediaAsset } from "../types";

/**
 * User-supplied media (focus-screen backdrop, bell) is kept inline as a
 * data: URL inside the settings table, so it travels with the database and
 * works the same in the desktop app and in the browser build.
 */

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

export const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
export const AUDIO_EXTS = ["mp3", "wav", "ogg", "m4a", "aac", "flac"];

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // before shrinking
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

/** Backdrop resolution presets: longest side in pixels and the size below which a JPEG/WebP is kept as-is. */
export type ImageQuality = "1080p" | "2k";
export const IMAGE_QUALITIES: readonly ImageQuality[] = ["1080p", "2k"];
export const IMAGE_QUALITY_SIDE: Record<ImageQuality, number> = { "1080p": 1920, "2k": 2560 };
export const IMAGE_QUALITY_KEEP_BYTES: Record<ImageQuality, number> = { "1080p": 900 * 1024, "2k": 2 * 1024 * 1024 };
export const IMAGE_QUALITY_LABEL: Record<ImageQuality, string> = { "1080p": "1080p (1920 px)", "2k": "2K (2560 px)" };
export const IMAGE_MAX_SIDE = IMAGE_QUALITY_SIDE["1080p"];

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Approximate decoded size of a data: URL in bytes. */
export function dataUrlBytes(data: string): number {
  const i = data.indexOf(",");
  if (i < 0) return 0;
  const b64 = data.length - i - 1;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64 * 3) / 4) - pad);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

/**
 * Let the user pick an image or audio file. Native dialog in Tauri, a hidden
 * file input in the browser. Resolves null when cancelled; throws when the
 * file is too large.
 */
export async function pickMedia(kind: "image" | "audio"): Promise<MediaAsset | null> {
  const exts = kind === "image" ? IMAGE_EXTS : AUDIO_EXTS;
  const max = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  const tooBig = (n: number) => new Error(`That file is ${fmtBytes(n)}; the limit is ${fmtBytes(max)}.`);

  if (isTauri()) {
    const path = await pickOpenFile([{ name: kind === "image" ? "Images" : "Audio", extensions: exts }]);
    if (!path) return null;
    const bytes = await readBytes(path);
    if (bytes.length > max) throw tooBig(bytes.length);
    return { name: basename(path), data: bytesToDataUrl(bytes, mimeFor(path)) };
  }

  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = exts.map((e) => `.${e}`).join(",");
    input.style.display = "none";
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    // Browsers fire no event on cancel; the element is simply left to be garbage-collected.
    document.body.appendChild(input);
    input.click();
  });
  if (!file) return null;
  if (file.size > max) throw tooBig(file.size);
  return { name: file.name, data: await readFileAsDataUrl(file) };
}

/**
 * Shrink a backdrop so it stays reasonably small: longest side capped by the
 * chosen quality preset (1080p → 1920 px, 2K → 2560 px), re-encoded as JPEG.
 * JPEG/WebP files already within the preset's size budget are kept as they are.
 */
export async function shrinkImage(asset: MediaAsset, preset: ImageQuality = "1080p", quality = 0.82): Promise<MediaAsset> {
  const maxSide = IMAGE_QUALITY_SIDE[preset];
  const keepBytes = IMAGE_QUALITY_KEEP_BYTES[preset];
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("That file is not an image the app can read."));
    el.src = asset.data;
  });
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const alreadyCompact = /^data:image\/(jpeg|webp)/.test(asset.data) && dataUrlBytes(asset.data) < keepBytes;
  if (longest <= maxSide && alreadyCompact) return asset;
  const scale = Math.min(1, maxSide / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return asset;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { name: asset.name, data: canvas.toDataURL("image/jpeg", quality) };
}

/** Turn a data: URL into a short-lived blob: URL (caller revokes it). */
export function dataUrlToObjectUrl(data: string): string {
  const comma = data.indexOf(",");
  const meta = data.slice(5, comma); // after "data:"
  const mime = meta.split(";")[0] || "application/octet-stream";
  const bin = atob(data.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
