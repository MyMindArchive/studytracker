import { useEffect, useRef, useState } from "react";

/**
 * Range input that shows live feedback while dragging but calls onCommit
 * exactly once per gesture, from the native `change` event (fired on release
 * for pointer drags and per step for keyboard changes). Prevents a drag from
 * producing dozens of pct_history rows.
 */
export function RangeSlider({
  value,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  className,
  style,
  ariaLabel,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  style?: React.CSSProperties;
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

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onChange={(e) => setDraft(Number(e.target.value))}
      onClick={(e) => e.stopPropagation()}
      className={className}
      style={style}
      aria-label={ariaLabel}
    />
  );
}
