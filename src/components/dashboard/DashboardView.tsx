import { useMemo, useState } from "react";
import { AlertTriangle, Flame } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../../store/app";
import {
  agingWip,
  estimateBias,
  hoursToday,
  plannedVsActual,
  reworkRate,
  sessionStats,
  thisWeekBySubject,
  timeBySubject,
  velocity,
  IDLE_DAYS,
  MIN_SUPPORT,
  PACE_WINDOW_WEEKS,
  UNASSIGNED,
  type AgingFlag,
  type DeadlineOutlook,
  type DeadlineVerdict,
  type AgingRow,
  type BiasRow,
  type SessionStats,
  type VelocityRow,
} from "../../lib/stats";
import { fmtDuration, fmtHours } from "../../lib/time";
import type { SessionSource } from "../../types";
import { ProgressBar } from "../ui/ProgressBar";
import { cn } from "../../lib/cn";

const UNASSIGNED_COLOR = "#9ca3af";

export function DashboardView() {
  const nodes = useApp((s) => s.nodes);
  const sessions = useApp((s) => s.sessions);
  const history = useApp((s) => s.history);
  const statusHistory = useApp((s) => s.statusHistory);
  const rollup = useApp((s) => s.rollup);
  const dailyTarget = useApp((s) => s.settings.daily_target_hours);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");
  const [showLeaves, setShowLeaves] = useState(false);

  const now = new Date();
  const today = useMemo(() => hoursToday(sessions, now), [sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const week = useMemo(() => thisWeekBySubject(nodes, sessions, now), [nodes, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = useMemo(() => timeBySubject(nodes, sessions, period, now), [nodes, sessions, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const pva = useMemo(() => plannedVsActual(nodes, sessions, rollup), [nodes, sessions, rollup]);
  const vel = useMemo(() => velocity(nodes, history, sessions, now), [nodes, history, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => sessionStats(sessions, now), [sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const aging = useMemo(() => agingWip(nodes, history, sessions, statusHistory, now), [nodes, history, sessions, statusHistory]); // eslint-disable-line react-hooks/exhaustive-deps
  const bias = useMemo(() => estimateBias(nodes, sessions), [nodes, sessions]);
  const rework = useMemo(() => reworkRate(nodes, history), [nodes, history]);

  const velocityRows = useMemo(() => {
    const weeks = vel[0]?.weekly.map((w) => w.week) ?? [];
    return weeks.map((wk, i) => {
      // null leaves a gap in the line for weeks before the project existed
      const row: Record<string, string | number | null> = { week: wk.slice(5) };
      for (const v of vel) {
        const pct = v.weekly[i].pct;
        row[v.subjectId] = pct === null ? null : Math.round(pct * 10) / 10;
      }
      return row;
    });
  }, [vel]);

  const reworkTotal = rework[0];
  const subjectsPva = pva.filter((r) => r.level === "subject");
  const leavesBySubject = new Map<string, typeof pva>();
  for (const r of pva) if (r.level === "leaf") leavesBySubject.set(r.subjectId, [...(leavesBySubject.get(r.subjectId) ?? []), r]);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="grid grid-cols-12 gap-4">
        {/* Today gauge */}
        <section className="card col-span-12 flex flex-col md:col-span-5 lg:col-span-4">
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
        <section className="card col-span-12 md:col-span-7 lg:col-span-8">
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

        {/* Needs attention */}
        <section className="card col-span-12">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">Needs attention</h2>
            <span className="text-[10px] text-muted">open tasks measured against how long your finished ones took</span>
          </div>
          {aging.length === 0 ? (
            <Empty>Nothing is overdue, blocked, running long or gone quiet.</Empty>
          ) : (
            <table className="mt-3 w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[24%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[10%]" />
                <col className="w-[8%]" />
                <col className="w-[6%]" />
              </colgroup>
              <thead className="table-head text-left text-[10px]">
                <tr>
                  <th className="py-1">Task</th>
                  <th className="py-1">Why</th>
                  <th className="py-1 text-right" title="Since the first logged hour or first percent above zero">
                    Open
                  </th>
                  <th className="py-1 text-right" title={`Since the last logged hour or percent change; ${IDLE_DAYS} days counts as quiet`}>
                    Quiet
                  </th>
                  <th className="py-1 text-right" title={`How long 85 % of comparable finished tasks took, once there are ${MIN_SUPPORT} of them`}>
                    Typical
                  </th>
                  <th className="py-1 text-right">Logged</th>
                  <th className="py-1 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {aging.slice(0, 12).map((r) => (
                  <AgingRowView
                    key={r.id}
                    r={r}
                    onOpen={() => {
                      select(r.id);
                      setView("tree");
                    }}
                  />
                ))}
              </tbody>
            </table>
          )}
          {aging.length > 12 && <p className="mt-2 text-[10px] text-muted">{aging.length - 12} more not shown.</p>}
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
        <section className="card col-span-12">
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
        <section className="card col-span-12">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">Pace &amp; finish</h2>
            <span className="text-[10px] text-muted">measured from each project&rsquo;s own start</span>
          </div>
          {vel.length === 0 ? (
            <Empty>Percent history drives this once you start updating tasks.</Empty>
          ) : (
            <>
              <div className="mt-2 h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={velocityRows} margin={{ top: 8, right: 16, left: -20, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: "var(--muted)" }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v}%`} />
                    {vel.map((v) => (
                      <Line
                        key={v.subjectId}
                        type="monotone"
                        dataKey={v.subjectId}
                        name={v.name}
                        stroke={v.color ?? "var(--accent)"}
                        dot={paceDot(v.color ?? "var(--accent)", velocityRows.length - 1)}
                        activeDot={{ r: 5 }}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <table className="mt-2 w-full text-xs">
                <thead className="table-head text-left text-[10px]">
                  <tr>
                    <th className="py-1">Project</th>
                    <th className="w-16 py-1 text-right">Now</th>
                    <th className="w-24 py-1 text-right" title="Percentage points you are gaining per week">
                      Pace <span className="font-normal opacity-70">pts/wk</span>
                    </th>
                    <th className="w-24 py-1 text-right" title="Percentage points per week needed from today to finish by the deadline">
                      Needed <span className="font-normal opacity-70">pts/wk</span>
                    </th>
                    <th className="w-36 py-1 text-right" title="Where this pace lands you on the deadline. Under 100 % means you miss it.">
                      By deadline
                    </th>
                    <th className="w-32 py-1 text-right" title="When this pace reaches 100 %, deadline or no deadline">
                      Finish
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vel.map((v) => (
                    <PaceRow key={v.subjectId} v={v} />
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] leading-4 text-muted">
                Pace is the points you gained divided by the days it took, counted from the day a project started (at most {PACE_WINDOW_WEEKS} weeks back). A
                project starts at the earliest of its creation or its first logged session, so backfilling hours you already put in moves the start back and
                corrects the pace. Needed is what it would take from today to reach 100&thinsp;% by the deadline &mdash; a project&rsquo;s own date, or the
                nearest one among its unfinished tasks. Compare the two: pace below needed is the gap you have to make up, and &ldquo;By deadline&rdquo; is
                where today&rsquo;s pace actually lands you. A young project&rsquo;s pace rests on very little; the dot beside it says how much.
              </p>
            </>
          )}
        </section>

        {/* Estimates */}
        <section className="card col-span-12">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">Estimates &amp; rework</h2>
            <span className="text-[10px] text-muted">finished tasks only</span>
          </div>
          <div className="mt-3 grid grid-cols-12 gap-4">
            <div className="col-span-12 lg:col-span-7">
              <BiasTable rows={bias} />
            </div>
            <div className="col-span-12 lg:col-span-5">
              <div className="grid grid-cols-2 gap-3">
                <Tile label="Went backwards" value={`${reworkTotal.backwards}`} big />
                <Tile label="Points given back" value={reworkTotal.pointsLost >= 1 ? reworkTotal.pointsLost.toFixed(0) : reworkTotal.pointsLost.toFixed(1)} big />
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted">
                {reworkTotal.moves === 0
                  ? "Rework shows up here once percentages start moving."
                  : `${(reworkTotal.rate * 100).toFixed(0)} % of your percent changes were downward, across ${reworkTotal.tasks} task${
                      reworkTotal.tasks === 1 ? "" : "s"
                    }. A percent that drops means work was redone, called done too early, or re-scoped — pace only ever shows the net.`}
              </p>
            </div>
          </div>
        </section>

        {/* Session stats */}
        <section className="card col-span-12">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">Sessions</h2>
            <span className="text-[10px] text-muted">{sourceLine(stats.sources)}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Sessions" value={String(stats.count)} big />
            <Tile label="Median length" value={fmtDuration(stats.medianSeconds)} big />
            {stats.completionRate === null ? (
              <Tile label="Days logged" value={String(stats.daysLogged)} big />
            ) : (
              <Tile label="Timer completion" value={`${Math.round(stats.completionRate * 100)}%`} big />
            )}
            <Tile label="Study streak" value={`${stats.streakDays} day${stats.streakDays === 1 ? "" : "s"}`} big />
          </div>
          <div className="mt-4">
            <div className="mb-1 flex items-baseline justify-between text-xs text-muted">
              <span>Hour-of-day heatmap (hours studied)</span>
              <span className="text-[10px]">{HEATMAP_NOTE[stats.heatmapBasis]}</span>
            </div>
            <Heatmap data={stats.heatmap} />
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted">
            Lengths are the median and the 85th percentile, not an average: one long Sunday would drag a mean somewhere no session ever was. Longest fifth of
            your blocks run {fmtDuration(stats.p85Seconds)} or more.
          </p>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------- needs attention */

const FLAG_LABEL: Record<AgingFlag, string> = {
  late: "overdue",
  blocked: "blocked",
  overrun: "running long",
  idle: "quiet",
  "not-started": "not started",
};

const FLAG_CLASS: Record<AgingFlag, string> = {
  late: "text-danger",
  blocked: "text-warn",
  overrun: "text-warn",
  idle: "text-muted",
  "not-started": "text-muted",
};

const FLAG_WHY: Record<AgingFlag, string> = {
  late: "Past its deadline and not finished.",
  blocked: "Flagged as waiting on something. Clear the flag on the task when it frees up.",
  overrun: "Open longer than 85 % of your comparable finished tasks took.",
  idle: `Nothing logged and no percent moved for ${IDLE_DAYS} days or more.`,
  "not-started": "Still at 0 % after the day it was meant to begin.",
};

/** "6 d", "3 wk", "4 mo" — the resolution the number actually has. */
function fmtDays(d: number | null): string {
  if (d === null) return "\u2013";
  const n = Math.max(0, d);
  if (n < 1) return "today";
  if (n < 14) return `${Math.round(n)} d`;
  if (n < 60) return `${Math.round(n / 7)} wk`;
  return `${Math.round(n / 30.44)} mo`;
}

function AgingRowView({ r, onOpen }: { r: AgingRow; onOpen: () => void }) {
  const why = [
    ...r.flags.map((f) => FLAG_WHY[f]),
    r.startedAt ? `First worked on ${r.startedAt.toLocaleDateString()}.` : "No hours logged and no percent above zero yet.",
    r.typicalDays !== null
      ? `Comparable finished tasks ${r.typicalFrom === "project" ? "in this project" : "across all projects"}: 85 % were done within ${fmtDays(r.typicalDays)}.`
      : `Not enough finished tasks yet to say what is typical (needs ${MIN_SUPPORT}).`,
    r.blockedDays !== null ? `Blocked for ${fmtDays(r.blockedDays)}.` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <tr className="border-t border-app align-middle" title={why}>
      <td className="py-1.5 pr-3">
        <button className="block w-full text-left" onClick={onOpen} title={`${r.subjectName} \u203a ${r.name}`}>
          <span className="flex items-center gap-1.5">
            <span className="dot h-2 w-2 shrink-0" style={{ background: r.color ?? "var(--accent)" }} />
            <span className="truncate hover:underline">{r.name}</span>
          </span>
          <span className="block truncate pl-3.5 text-[10px] text-muted">{r.subjectName}</span>
        </button>
      </td>
      <td className="py-1.5 pr-3">
        <span className="flex flex-wrap gap-1">
          {r.flags.map((f) => (
            <span
              key={f}
              className={cn("tag", FLAG_CLASS[f])}
              title={FLAG_WHY[f]}
            >
              {f === "late" || f === "blocked" ? <AlertTriangle size={9} className="mr-0.5 inline align-[-1px]" /> : null}
              {FLAG_LABEL[f]}
              {f === "blocked" && r.blockedDays !== null ? ` ${fmtDays(r.blockedDays)}` : ""}
            </span>
          ))}
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums">{fmtDays(r.ageDays)}</td>
      <td className={cn("py-1.5 text-right tabular-nums", (r.idleDays ?? 0) >= IDLE_DAYS && "text-warn")}>{fmtDays(r.idleDays)}</td>
      <td className="py-1.5 text-right tabular-nums text-muted">
        {r.typicalDays === null ? "\u2013" : fmtDays(r.typicalDays)}
        {r.typicalFrom === "all" && r.typicalDays !== null && <span className="ml-0.5 text-[9px] opacity-70">all</span>}
      </td>
      <td className="py-1.5 text-right tabular-nums">{fmtHours(r.hoursLogged)}</td>
      <td className="py-1.5 text-right tabular-nums">{r.pct.toFixed(0)}%</td>
    </tr>
  );
}

/* ----------------------------------------------------- estimate bias */

/** "1.8x over", "0.7x under", "on the money". */
function fmtRatio(ratio: number | null): { text: string; cls: string } {
  if (ratio === null) return { text: "\u2013", cls: "text-muted" };
  if (ratio >= 0.9 && ratio <= 1.1) return { text: `${ratio.toFixed(2)}\u00d7`, cls: "text-ok" };
  return { text: `${ratio.toFixed(2)}\u00d7`, cls: ratio > 1 ? "text-warn" : "text-accent" };
}

function BiasTable({ rows }: { rows: BiasRow[] }) {
  const pooled = rows[0];
  if (!pooled || pooled.samples === 0) {
    return <Empty>Finish a task that had an estimate and some logged hours, and the bias shows up here.</Empty>;
  }
  return (
    <>
      <p className="mb-2 text-xs text-muted">
        Across {pooled.samples} finished task{pooled.samples === 1 ? "" : "s"} you log{" "}
        <span className={cn("font-medium", fmtRatio(pooled.ratio).cls)}>{fmtRatio(pooled.ratio).text}</span> your estimate
        {pooled.ratio !== null && pooled.ratio > 1.1 ? " — a four-hour estimate really costs " + fmtHours(4 * pooled.ratio) + "." : "."}
      </p>
      <table className="w-full text-xs">
        <thead className="table-head text-left text-[10px]">
          <tr>
            <th className="py-1">Project</th>
            <th className="py-1 text-right">Tasks</th>
            <th className="py-1 text-right">Est.</th>
            <th className="py-1 text-right">Actual</th>
            <th className="py-1 text-right" title="Median of actual ÷ estimate, averaged in log space so 2x over and 2x under cancel out">
              Ratio
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const f = fmtRatio(r.ratio);
            return (
              <tr
                key={r.subjectId ?? "all"}
                className={cn("border-t border-app", r.subjectId === null && "font-medium")}
                title={
                  r.fallback
                    ? `Only ${r.samples} finished task${r.samples === 1 ? "" : "s"} here — fewer than ${MIN_SUPPORT}, so this borrows the pooled ratio instead of resting on too little.`
                    : `${r.samples} finished task${r.samples === 1 ? "" : "s"} behind this ratio.`
                }
              >
                <td className="max-w-0 truncate py-1">
                  {r.color && <span className="dot mr-1.5 h-2 w-2" style={{ background: r.color }} />}
                  {r.name}
                </td>
                <td className="py-1 text-right tabular-nums">{r.samples}</td>
                <td className="py-1 text-right tabular-nums text-muted">{fmtHours(r.estHours)}</td>
                <td className="py-1 text-right tabular-nums">{fmtHours(r.actualHours)}</td>
                <td className={cn("py-1 text-right tabular-nums", f.cls)}>
                  {f.text}
                  {r.fallback && <span className="ml-0.5 text-[9px] opacity-70">pooled</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/* ---------------------------------------------------------- sessions */

const HEATMAP_NOTE: Record<SessionStats["heatmapBasis"], string> = {
  timer: "timed blocks only",
  entered: "start times as you typed them",
  none: "",
};

/** "12 timed · 40 logged by hand" — what the numbers above are actually made of. */
function sourceLine(sources: Record<SessionSource, number>): string {
  const parts: string[] = [];
  if (sources.timer) parts.push(`${sources.timer} timed`);
  if (sources.manual) parts.push(`${sources.manual} logged by hand`);
  if (sources.imported) parts.push(`${sources.imported} imported`);
  if (sources.unknown) parts.push(`${sources.unknown} before this was recorded`);
  return parts.join(" \u00b7 ");
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

/* --------------------------------------------------------------- pace */

/** "3 days", "1.0 wk", "6 wk" — the span a pace was measured over. */
function fmtSpan(weeks: number): string {
  if (weeks < 1) return `${Math.max(1, Math.round(weeks * 7))} d`;
  return `${weeks < 3 ? weeks.toFixed(1) : Math.round(weeks)} wk`;
}

/** "~2 wk", "<1 wk", "9 mo" — never a precision the number does not have. */
function fmtRemaining(weeks: number): string {
  if (weeks < 1) return "<1 wk";
  if (weeks < 8) return `~${Math.round(weeks)} wk`;
  if (weeks < 52) return `~${Math.round(weeks / 4.345)} mo`;
  return "over a year";
}

function fmtEta(d: Date, now = new Date()): string {
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Small dot per week, fat ringed dot on the latest one — "where this project
 * stands now" should be findable without reading the axis.
 */
function paceDot(color: string, lastIndex: number) {
  return function Dot(props: { cx?: number; cy?: number; index?: number; key?: string }) {
    const { cx, cy, index } = props;
    if (cx == null || cy == null) return <g />;
    const latest = index === lastIndex;
    return (
      <circle
        cx={cx}
        cy={cy}
        r={latest ? 5 : 2.5}
        fill={color}
        stroke={latest ? "var(--panel)" : "none"}
        strokeWidth={latest ? 2 : 0}
      />
    );
  };
}

const CONFIDENCE_DOT: Record<VelocityRow["confidence"], string> = {
  none: "bg-muted opacity-40",
  thin: "bg-warn",
  fair: "bg-accent",
  good: "bg-ok",
};

const CONFIDENCE_WHY: Record<VelocityRow["confidence"], string> = {
  none: "Nothing has moved yet, so there is no pace to measure.",
  thin: "Only one week of real movement so far — one good or bad week will swing this a lot.",
  fair: "A few weeks of movement. Usable, still jumpy.",
  good: "Several weeks of steady movement behind this.",
};

const VERDICT_TONE: Record<DeadlineVerdict, string> = {
  "on-track": "text-ok",
  tight: "text-warn",
  behind: "text-danger",
  overdue: "text-danger",
  done: "text-ok",
};

function PaceRow({ v }: { v: VelocityRow }) {
  const o = v.outlook;
  const why = [
    `${v.gained >= 0 ? "+" : ""}${v.gained.toFixed(1)} points over ${fmtSpan(v.basisWeeks)}`,
    `${v.activeWeeks} week${v.activeWeeks === 1 ? "" : "s"} of that moved (${v.activePace.toFixed(1)} pts/wk while working)`,
    v.startedAt ? `started ${fmtEta(v.startedAt)}` : null,
    CONFIDENCE_WHY[v.confidence],
    o ? deadlineWhy(v, o) : "No deadline on this project or its tasks, so there is nothing to be on track for.",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <tr className="border-t border-app" title={why}>
      <td className="max-w-0 truncate py-1">
        <span className="dot mr-1.5 h-2 w-2" style={{ background: v.color ?? "var(--accent)" }} />
        {v.name}
      </td>
      <td className="py-1 text-right tabular-nums">{v.currentPct.toFixed(1)}%</td>
      <td className="py-1 text-right">
        <span className={cn("inline-flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums", v.velocity <= 0 && "text-muted")}>
          {v.status === "ok" ? fmtPts(v.velocity) : "\u2013"}
          {v.status === "ok" && <span className={cn("dot h-1.5 w-1.5", CONFIDENCE_DOT[v.confidence])} />}
        </span>
      </td>
      <td className="py-1 text-right tabular-nums">
        {o === null || o.needed === null ? <span className="text-muted">&ndash;</span> : o.verdict === "done" ? <span className="text-muted">&ndash;</span> : fmtPts(o.needed)}
      </td>
      <td className="py-1 text-right">
        {o === null ? (
          <span className="text-muted" title="Set a deadline on this project, or on one of its tasks, to see this.">
            no deadline
          </span>
        ) : (
          <span className={cn("whitespace-nowrap tabular-nums", VERDICT_TONE[o.verdict])}>
            {o.verdict === "done" ? "done" : o.verdict === "overdue" ? "overdue" : `${o.projectedPct.toFixed(0)}%`}{" "}
            <span className="text-muted" title={o.inherited ? "Date taken from a task, not from the project itself" : undefined}>
              · {o.inherited ? "→" : ""}
              {fmtEta(o.date)}
            </span>
          </span>
        )}
      </td>
      <td className="py-1 text-right">
        {v.status === "done" ? (
          <span className="text-ok">done</span>
        ) : v.status === "stalled" || v.etaDate === null ? (
          <span className="text-muted" title="Nothing has moved forward yet, so there is no rate to project from.">
            stalled
          </span>
        ) : (
          <span className="whitespace-nowrap tabular-nums">
            {fmtRemaining(v.forecastWeeks!)} <span className="text-muted">· {fmtEta(v.etaDate)}</span>
          </span>
        )}
      </td>
    </tr>
  );
}

/** Plain-language version of the two deadline numbers, for the row tooltip. */
function deadlineWhy(v: VelocityRow, o: DeadlineOutlook): string {
  const when = `${fmtEta(o.date)}${o.inherited ? " (from a task, not the project)" : ""}`;
  if (o.verdict === "done") return `Finished. Deadline was ${when}.`;
  if (o.verdict === "overdue") return `Deadline ${when} has passed with ${(100 - v.currentPct).toFixed(0)} points still open.`;
  const days = o.daysLeft === 0 ? "today" : `in ${o.daysLeft} day${o.daysLeft === 1 ? "" : "s"}`;
  const rate = `You are gaining ${fmtPts(v.velocity)} pts/wk and need ${fmtPts(o.needed!)}.`;
  if (o.verdict === "on-track") return `Due ${when}, ${days}. ${rate} This pace gets there.`;
  return `Due ${when}, ${days}. ${rate} This pace lands at ${o.projectedPct.toFixed(0)} %, ${(100 - o.projectedPct).toFixed(0)} points short.`;
}

/** Whole numbers once the rate is big enough that a decimal is false precision. */
function fmtPts(n: number): string {
  return Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1);
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
