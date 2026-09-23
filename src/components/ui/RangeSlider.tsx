import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

/**
 * Range input that shows live feedback while dragging but calls onCommit
 * exactly once per gesture, from the native `change` event (fired on release
 * for pointer drags and per step for keyboard changes). Prevents a drag from
 * producing dozens of pct_history rows.
 *
 * Drawn by the `.range` class rather than the browser: a native track picks its
 * own unfilled colour (near-black in light mode, white in dark) and ignores the
 * skins, so a column of sliders outweighed everything else in the tree.
 */
export function RangeSlider({
  value,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  color,
  className,
  ariaLabel,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** fill colour; defaults to the accent */
  color?: string | null;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      setDraft(null);
      commitRef.current(Number(el.value));
    };
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);

  useEffect(() => setDraft(null), [value]);

  const shown = draft ?? value;
  const fill = ((shown - min) / (max - min || 1)) * 100;

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={shown}
      onChange={(e) => setDraft(Number(e.target.value))}
      onClick={(e) => e.stopPropagation()}
      className={cn("range", className)}
      style={{ "--range-color": color ?? "var(--accent)", "--range-fill": `${fill}%` } as React.CSSProperties}
      aria-label={ariaLabel}
    />
  );
}
