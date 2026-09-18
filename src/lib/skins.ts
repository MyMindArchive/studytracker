import type { SkinId } from "../types";

/**
 * Skins are pure CSS: each one overrides the design tokens (and a few
 * component classes) under `html[data-skin="…"]` in index.css. Components
 * never branch on the skin; they use the semantic classes and tokens.
 */
export interface SkinDef {
  id: SkinId;
  label: string;
  blurb: string;
  /** swatch colours for the picker: [background, panel, accent, foreground] */
  swatch: [string, string, string, string];
}

export const SKINS: SkinDef[] = [
  {
    id: "clean",
    label: "Clean",
    blurb: "The original. Quiet greys, indigo accent, light or dark.",
    swatch: ["#f7f7f8", "#ffffff", "#4f46e5", "#16161a"],
  },
  {
    id: "terminal",
    label: "Terminal",
    blurb: "Monospace, square corners, phosphor green. Light or dark.",
    swatch: ["#0b0f0c", "#101511", "#39ff88", "#d6f5e1"],
  },
  {
    id: "soft",
    label: "Soft",
    blurb: "Rounded pastel cards with gentle shadows. Light or dark.",
    swatch: ["#f4f1fb", "#ffffff", "#7c5cff", "#2a2540"],
  },
];
