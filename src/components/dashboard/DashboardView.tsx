import { useMemo, useState } from "react";
import { AlertTriangle, Flame } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../../store/app";
import { hoursToday, plannedVsActual, sessionStats, thisWeekBySubject, timeBySubject, velocity, UNASSIGNED } from "../../lib/stats";
import { fmtDuration, fmtHours } from "../../lib/time";
import { ProgressBar } from "../ui/ProgressBar";
import { cn } from "../../lib/cn";

const UNASSIGNED_COLOR = "#9ca3af";

export function DashboardView() {
  const nodes = useApp((s) => s.nodes);
  const sessions = useApp((s) => s.sessions);
  const history = useApp((s) => s.history);
  const rollup = useApp((s) => s.rollup);
  const dailyTarget = useApp((s) => s.settings.daily_target_hours);
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");
  const [showLeaves, setShowLeaves] = useState(false);

  const now = new Date();
  const today = useMemo(() => hoursToday(sessions, now), [sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const week = useMemo(() => thisWeekBySubject(nodes, sessions, now), [nodes, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = useMemo(() => timeBySubject(nodes, sessions, period, now), [nodes, sessions, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const pva = useMemo(() => plannedVsActual(nodes, sessions, rollup), [nodes, sessions, rollup]);
  const vel = useMemo(() => velocity(nodes, history, now), [nodes, history]); // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => sessionStats(sessions, now), [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const velocityRows = useMemo(() => {
    const weeks = vel[0]?.weekly.map((w) => w.week) ?? [];
    return weeks.map((wk, i) => {
      const row: Record<string, string | number> = { week: wk.slice(5) };
      for (const v of vel) row[v.subjectId] = Math.round(v.weekly[i].pct * 10) / 10;
      return row;
    });
  }, [vel]);

  const subjectsPva = pva.filter((r) => r.level === "subject");
  const leavesBySubject = new Map<string, typeof pva>();
  for (const r of pva) if (r.level === "leaf") leavesBySubject.set(r.subjectId, [...(leavesBySubject.get(r.subjectId) ?? []), r]);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="grid grid-cols-12 gap-4">
        {/* Today gauge */}
        <section className="card col-span-4 flex flex-col">
          <h2 className="section-title">Today</h2>
          <div className="flex flex-1 flex-col items-center justify-center py-2">
            <Gauge value={today} max={dailyTarget} />
            <div className="-mt-6 text-center">
              <div className="stat text-3xl">{fmtHours(today)}</div>
              <div className="text-xs text-muted">of {fmtHours(dailyTarget, 1)} daily target</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center text-xs">
            <Tile label="Streak" value={`${stats.streakDays}d`} icon={stats.streakDays > 0 ? <Flame size={12} className="text-warn" /> : undefined} />
            <Tile label="All time" value={fmtHours(stats.totalHours, 0)} />
          </div>
        </section>

        {/* This week per project */}
        <section className="card col-span-8">
          <h2 className="section-title">This week per project</h2>
          {week.length === 0 ? (
            <Empty>Add projects with a weekly target to track them here.</Empty>
          ) : (
            <ul className="mt-3 flex flex-col gap-2.5">
              {week.map((w) => {
                const pct = w.target ? (w.hours / w.target) * 100 : 0;
                return (
                  <li key={w.subjectId} className="grid grid-cols-[160px_1fr_140px] items-center gap-3 text-sm">
                    <div className="flex items-center gap-2 truncate">
                      <span className="dot h-2.5 w-2.5" style={{ background: w.color ?? "var(--accent)" }} />
                      <span className="truncate">{w.name}</span>
                    </div>
                    <ProgressBar pct={w.target ? pct : w.hours > 0 ? 100 : 0} color={w.color} />
                    <div className="flex items-center justify-end gap-2 tabular-nums text-xs">
                      <span>{fmtHours(w.hours)}</span>
                      <span className="text-muted">/ {w.target != null ? fmtHours(w.target, 0) : "–"}</span>
                      {w.behindTwoWeeks && (
                        <span className="flex items-center gap-1 text-warn" title="Below target the last two full weeks">
                          <AlertTriangle size={12} /> 2 wks
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Time by project */}
        <section className="card col-span-12">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Time by project</h2>
            <div className="seg">
              {(["day", "week", "month"] as const).map((p) => (
                <button key={p} onClick={() => setPeriod(p)} className="seg-item" data-active={period === p}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(v: string) => (period === "month" ? v : v.slice(5))} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} width={52} tickFormatter={fmtAxisHours} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtHours(Number(v))} labelStyle={{ color: "var(--muted)" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {series.keys.map((k) => (
                  <Bar key={k.key} dataKey={k.key} name={k.name} stackId="t" fill={k.key === UNASSIGNED ? UNASSIGNED_COLOR : k.color ?? "var(--accent)"} radius={0} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Planned vs actual */}
        <section className="card col-span-7">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Planned vs actual</h2>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={showLeaves} onChange={(e) => setShowLeaves(e.target.checked)} /> show leaf tasks
            </label>
          </div>
          {subjectsPva.length === 0 ? (
            <Empty>No projects yet.</Empty>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="table-head text-left">
                <tr>
                  <th className="py-1">Node</th>
                  <th className="py-1 text-right">Est. h</th>
                  <th className="py-1 text-right">Logged</th>
                  <th className="py-1 text-right">%</th>
                  <th className="py-1 text-right">Flag</th>
                </tr>
              </thead>
              <tbody>
                {subjectsPva.map((s) => (
                  <PvaRows key={s.id} subject={s} leaves={showLeaves ? leavesBySubject.get(s.subjectId) ?? [] : []} />
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Velocity */}
        <section className="card col-span-5">
          <h2 className="section-title">Velocity</h2>
          {vel.length === 0 ? (
            <Empty>Percent history drives this once you start updating tasks.</Empty>
          ) : (
            <>
              <div className="mt-2 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={velocityRows} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: "var(--muted)" }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v}%`} />
                    {vel.map((v) => (
                      <Line key={v.subjectId} type="monotone" dataKey={v.subjectId} name={v.name} stroke={v.color ?? "var(--accent)"} dot={false} strokeWidth={2} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <table className="mt-2 w-full text-xs">
                <thead className="table-head text-left text-[10px]">
                  <tr>
                    <th className="py-1">Project</th>
                    <th className="py-1 text-right">Now</th>
                    <th className="py-1 text-right">pts / wk</th>
                    <th className="py-1 text-right">Weeks to 100</th>
                  </tr>
                </thead>
                <tbody>
                  {vel.map((v) => (
                    <tr key={v.subjectId} className="border-t border-app">
                      <td className="py-1">
                        <span className="dot mr-1.5 h-2 w-2" style={{ background: v.color ?? "var(--accent)" }} />
                        {v.name}
                      </td>
                      <td className="py-1 text-right tabular-nums">{v.currentPct.toFixed(1)}%</td>
                      <td className="py-1 text-right tabular-nums">{v.velocity.toFixed(1)}</td>
                      <td className="py-1 text-right tabular-nums">{v.forecastWeeks === null ? "–" : v.forecastWeeks === 0 ? "done" : `~${Math.ceil(v.forecastWeeks)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        {/* Session stats */}
        <section className="card col-span-12">
          <h2 className="section-title">Sessions</h2>
          <div className="mt-3 grid grid-cols-4 gap-3">
            <Tile label="Sessions" value={String(stats.count)} big />
            <Tile label="Average length" value={fmtDuration(stats.avgSeconds)} big />
            <Tile label="Completion rate" value={`${Math.round(stats.completionRate * 100)}%`} big />
            <Tile label="Study streak" value={`${stats.streakDays} day${stats.streakDays === 1 ? "" : "s"}`} big />
          </div>
          <div className="mt-4">
            <div className="mb-1 text-xs text-muted">Hour-of-day heatmap (hours studied)</div>
            <Heatmap data={stats.heatmap} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** Axis labels in the unit that keeps neighbouring ticks distinct: s, m or h. */
function fmtAxisHours(v: number): string {
  if (v === 0) return "0";
  if (v < 2 / 60) return `${Math.round(v * 3600)}s`;
  if (v < 1) {
    const m = v * 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, "")}m`;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)}h`;
}

const tooltipStyle = { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg)" };

function PvaRows({ subject, leaves }: { subject: ReturnType<typeof plannedVsActual>[number]; leaves: ReturnType<typeof plannedVsActual> }) {
  return (
    <>
      <tr className="border-t border-app font-medium">
        <td className="py-1.5">
          <span className="dot mr-1.5 h-2 w-2" style={{ background: subject.color ?? "var(--accent)" }} />
          {subject.name}
        </td>
        <td className="py-1.5 text-right tabular-nums">{subject.estHours == null ? "–" : fmtHours(subject.estHours)}</td>
        <td className="py-1.5 text-right tabular-nums">{fmtHours(subject.hoursLogged)}</td>
        <td className="py-1.5 text-right tabular-nums">{subject.pct.toFixed(0)}%</td>
        <td className="py-1.5 text-right">{subject.overrun && <Flag />}</td>
      </tr>
      {leaves.map((l) => (
        <tr key={l.id} className="text-muted">
          <td className="py-1 pl-6">{l.name}</td>
          <td className="py-1 text-right tabular-nums">{l.estHours == null ? "–" : fmtHours(l.estHours)}</td>
          <td className="py-1 text-right tabular-nums">{fmtHours(l.hoursLogged)}</td>
          <td className="py-1 text-right tabular-nums">{l.pct.toFixed(0)}%</td>
          <td className="py-1 text-right">{l.overrun && <Flag />}</td>
        </tr>
      ))}
    </>
  );
}

function Flag() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-warn" title="Hours logged exceed the estimate while under 80% complete">
      <AlertTriangle size={11} /> over
    </span>
  );
}

function Tile({ label, value, big, icon }: { label: string; value: string; big?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="tile">
      <div className="table-head text-[10px]">{label}</div>
      <div className={cn("stat flex items-center justify-center gap-1", big ? "text-xl" : "text-sm")}>
        {icon}
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-8 text-center text-xs text-muted">{children}</div>;
}

/** Semi-circular gauge. */
function Gauge({ value, max }: { value: number; max: number }) {
  const w = 220,
    h = 120,
    r = 95,
    stroke = 16;
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const arc = (f: number) => {
    const a = Math.PI * (1 - f);
    return { x: w / 2 + r * Math.cos(a), y: h - 10 - r * Math.sin(a) };
  };
  const s = arc(0),
    e = arc(1),
    m = arc(frac);
  const bg = `M${s.x},${s.y} A${r},${r} 0 0 1 ${e.x},${e.y}`;
  const fg = frac <= 0 ? "" : `M${s.x},${s.y} A${r},${r} 0 0 1 ${m.x},${m.y}`;
  return (
    <svg width={w} height={h}>
      <path d={bg} fill="none" stroke="var(--panel-2)" strokeWidth={stroke} strokeLinecap="round" />
      {fg && <path d={fg} fill="none" stroke={frac >= 1 ? "var(--ok)" : "var(--accent)"} strokeWidth={stroke} strokeLinecap="round" />}
    </svg>
  );
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function Heatmap({ data }: { data: number[][] }) {
  const max = Math.max(0.01, ...data.flat());
  return (
    <div className="grid gap-px" style={{ gridTemplateColumns: "36px repeat(24, minmax(0, 1fr))" }}>
      <div />
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="text-center text-[9px] text-muted">
          {h % 3 === 0 ? h : ""}
        </div>
      ))}
      {data.map((row, d) => (
        <RowCells key={d} label={DOW[d]} row={row} max={max} />
      ))}
    </div>
  );
}
function RowCells({ label, row, max }: { label: string; row: number[]; max: number }) {
  return (
    <>
      <div className="pr-1 text-right text-[10px] text-muted leading-4">{label}</div>
      {row.map((v, h) => (
        <div
          key={h}
          className="h-4 rounded-[2px]"
          title={`${label} ${h}:00 – ${fmtHours(v)}`}
          style={{ background: v > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(15 + (v / max) * 85)}%, var(--panel-2))` : "var(--panel-2)" }}
        />
      ))}
    </>
  );
}
