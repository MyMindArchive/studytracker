import { cn } from "../../lib/cn";

export function ProgressBar({ pct, color, className, height = "h-2" }: { pct: number; color?: string | null; className?: string; height?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={cn("progress", height, className)} role="progressbar" aria-valuenow={Math.round(p)}>
      <div className="progress-fill" style={{ width: `${p}%`, backgroundColor: color ?? "var(--accent)" }} />
    </div>
  );
}
