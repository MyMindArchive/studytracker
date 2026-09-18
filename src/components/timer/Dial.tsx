import { useId, useRef, type PointerEvent } from "react";

const MAX_DIAL_MINUTES = 120;
const TICKS = 60;

/**
 * Timer ring in the spirit of the iOS Timer: a faint minute-tick halo, a thin
 * track and a gradient arc with rounded caps and a soft glow. When
 * interactive, dragging around the ring sets the duration (one full turn =
 * 120 minutes).
 */
export function Dial({
  size,
  progress,
  color,
  interactive,
  minutes,
  onMinutes,
}: {
  size: number;
  progress: number; // 0..1 completed
  color: string;
  interactive: boolean;
  minutes: number;
  onMinutes: (m: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const gid = useId();
  const stroke = 12;
  const tickRing = 14; // space reserved outside the arc for the tick marks
  const r = size / 2 - tickRing - stroke / 2;
  const c = 2 * Math.PI * r;
  const shown = interactive ? Math.min(1, minutes / MAX_DIAL_MINUTES) : 1 - Math.max(0, Math.min(1, progress));
  const dash = Math.max(0.001, c * shown);
  const cx = size / 2;

  const minutesFromEvent = (e: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    let ang = Math.atan2(x, -y); // 0 at top, clockwise
    if (ang < 0) ang += Math.PI * 2;
    const m = Math.round((ang / (Math.PI * 2)) * MAX_DIAL_MINUTES);
    return Math.max(1, m === 0 ? MAX_DIAL_MINUTES : m);
  };

  const dragging = useRef(false);
  const onDown = (e: PointerEvent) => {
    if (!interactive) return;
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onMinutes(minutesFromEvent(e));
  };
  const onMove = (e: PointerEvent) => {
    if (!interactive || !dragging.current) return;
    onMinutes(minutesFromEvent(e));
  };
  const onUp = () => (dragging.current = false);

  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const a = (i / TICKS) * Math.PI * 2;
    const major = i % 5 === 0;
    const outer = size / 2 - 1;
    const inner = outer - (major ? 9 : 5);
    return { i, major, x1: cx + inner * Math.sin(a), y1: cx - inner * Math.cos(a), x2: cx + outer * Math.sin(a), y2: cx - outer * Math.cos(a) };
  });

  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      className={interactive ? "cursor-pointer select-none" : "select-none"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role={interactive ? "slider" : undefined}
      aria-valuenow={interactive ? minutes : undefined}
      aria-label={interactive ? "Duration in minutes" : undefined}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={color} />
          <stop offset="100%" stopColor={color} stopOpacity={0.55} />
        </linearGradient>
      </defs>
      <g strokeWidth={1.5} strokeLinecap="round">
        {ticks.map((t) => (
          <line key={t.i} className="dial-tick" data-major={t.major} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
        ))}
      </g>
      <circle className="dial-track" cx={cx} cy={cx} r={r} fill="none" strokeWidth={stroke} />
      <circle
        className="dial-arc"
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: interactive ? "none" : "stroke-dasharray 250ms linear", filter: `drop-shadow(0 0 var(--dial-glow) ${color})` }}
      />
      {interactive && (
        <circle
          cx={cx + r * Math.sin(shown * Math.PI * 2)}
          cy={cx - r * Math.cos(shown * Math.PI * 2)}
          r={stroke / 2 + 4}
          fill="var(--panel)"
          stroke={color}
          strokeWidth={3}
          style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.25))" }}
        />
      )}
    </svg>
  );
}
