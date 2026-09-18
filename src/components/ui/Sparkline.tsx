import { useLayoutEffect, useRef, useState } from "react";

/**
 * Tiny line chart of 0..100 values. Without an explicit `width` it fills its
 * container and follows resizes, so it never overflows a narrow panel.
 */
export function Sparkline({ points, width, height = 36, color = "var(--accent)" }: { points: number[]; width?: number; height?: number; color?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    if (width !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const apply = () => setMeasured(el.clientWidth);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  if (points.length === 0) return <div className="text-xs text-muted">No history yet</div>;
  const w = width ?? measured;
  const pts = points.length === 1 ? [points[0], points[0]] : points;
  const max = 100;
  const step = w / (pts.length - 1);
  const y = (p: number) => height - (p / max) * (height - 2) - 1;
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} className="block">
          <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={(pts.length - 1) * step} cy={y(pts[pts.length - 1])} r={2.5} fill={color} />
        </svg>
      )}
    </div>
  );
}
