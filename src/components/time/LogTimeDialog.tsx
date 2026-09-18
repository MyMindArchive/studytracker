import { useEffect, useMemo, useState } from "react";
import { addDays, differenceInCalendarDays, format, parseISO, isValid } from "date-fns";
import { CalendarPlus } from "lucide-react";
import { useApp } from "../../store/app";
import { Modal } from "../ui/Modal";
import { Field, NumberInput } from "../ui/Field";
import { NodePicker } from "../ui/NodePicker";
import { fmtHours } from "../../lib/time";
import type { Session } from "../../types";
import { cn } from "../../lib/cn";

/** Longest backfill accepted in one go, so a mistyped year cannot write 40 000 rows. */
const MAX_DAYS = 366;
/** Per-day amount above this is almost certainly a typo, so it gets a warning. */
const IMPLAUSIBLE_HOURS_PER_DAY = 16;

const QUICK: { label: string; minutes: number }[] = [
  { label: "+30m", minutes: 30 },
  { label: "+1h", minutes: 60 },
  { label: "+2h", minutes: 120 },
  { label: "+4h", minutes: 240 },
];

/** Split `total` into `n` whole parts that add back up to exactly `total`. */
function split(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const out = Array(n).fill(base);
  let left = total - base * n;
  for (let i = 0; left > 0; i++, left--) out[i] += 1;
  return out;
}

/**
 * Records time that was already worked — before StudyTracker, away from the
 * desk, or on a day the timer was never started. Everything it writes is an
 * ordinary session, so it shows up in hours, charts, pace and exports exactly
 * like a timed one.
 */
export function LogTimeDialog({
  open,
  onOpenChange,
  nodeId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** pre-selected task; the picker still lets it be changed */
  nodeId?: string | null;
}) {
  const logSessions = useApp((s) => s.logSessions);
  const toast = useApp((s) => s.toast);
  const nodes = useApp((s) => s.nodes);

  const today = format(new Date(), "yyyy-MM-dd");
  const [target, setTarget] = useState<string | null>(nodeId ?? null);
  const [hours, setHours] = useState<number | null>(2);
  const [minutes, setMinutes] = useState<number | null>(0);
  const [date, setDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [startTime, setStartTime] = useState("09:00");
  const [spread, setSpread] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Reopening the dialog should start clean, but keep whatever task it was opened on.
  useEffect(() => {
    if (!open) return;
    const d = format(new Date(), "yyyy-MM-dd");
    setTarget(nodeId ?? null);
    setHours(2);
    setMinutes(0);
    setDate(d);
    setEndDate(d);
    setStartTime("09:00");
    setSpread(false);
    setNote("");
  }, [open, nodeId]);

  const totalSeconds = Math.max(0, Math.round(((hours ?? 0) * 60 + (minutes ?? 0)) * 60));

  const plan = useMemo(() => {
    const from = parseISO(date);
    const to = parseISO(spread ? endDate : date);
    if (!isValid(from) || !isValid(to)) return { error: "Pick a valid date", days: 0, perDay: [] as number[] };
    const days = differenceInCalendarDays(to, from) + 1;
    if (days < 1) return { error: "The end date is before the start date", days: 0, perDay: [] };
    if (days > MAX_DAYS) return { error: `That range covers ${days} days — ${MAX_DAYS} is the most in one go`, days, perDay: [] };
    if (totalSeconds <= 0) return { error: null, days, perDay: [] };
    return { error: null, days, perDay: split(totalSeconds, days) };
  }, [date, endDate, spread, totalSeconds]);

  const perDayHours = plan.days > 0 ? totalSeconds / 3600 / plan.days : 0;
  const heavy = perDayHours > IMPLAUSIBLE_HOURS_PER_DAY;
  const targetName = target ? nodes.find((n) => n.id === target)?.name : null;
  const canSave = totalSeconds > 0 && !plan.error && plan.perDay.length > 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const base = new Date(`${date}T${startTime || "09:00"}`);
      if (!isValid(base)) throw new Error("Pick a valid start time");
      const list: Omit<Session, "id">[] = plan.perDay.map((secs, i) => {
        const started = addDays(base, i);
        return {
          node_id: target,
          cycle_id: null,
          mode: "single",
          planned_seconds: secs,
          actual_seconds: secs,
          started_at: started.toISOString(),
          ended_at: new Date(started.getTime() + secs * 1000).toISOString(),
          ended_reason: "completed",
          note: note.trim() || null,
        };
      });
      const written = await logSessions(list);
      toast(
        `Logged ${fmtHours(totalSeconds / 3600)}${targetName ? ` to ${targetName}` : " to the inbox"}` +
          (written.length > 1 ? ` across ${written.length} days` : ""),
        { label: "Undo", run: () => void useApp.getState().undo() },
      );
      onOpenChange(false);
    } catch (e) {
      toast(`Could not log that time: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Log time already worked"
      description="Hours you put in before StudyTracker, or away from the timer. They count exactly like timed sessions."
      width="max-w-lg"
      footer={
        <>
          <button className="btn" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canSave} onClick={save}>
            <CalendarPlus size={14} /> {busy ? "Logging…" : "Log time"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <Field label="Task" hint="leave empty to sort it out from the inbox later">
          <NodePicker value={target} onChange={setTarget} emptyLabel="— Inbox (unassigned) —" className="input w-full" />
        </Field>

        <Field label="How much" hint="total across the whole range">
          <div className="flex flex-wrap items-center gap-2">
            <NumberInput value={hours} min={0} max={10_000} step={1} className="input w-20 text-right" onChange={setHours} />
            <span className="text-sm text-muted">h</span>
            <NumberInput value={minutes} min={0} max={59} step={5} className="input w-20 text-right" onChange={setMinutes} />
            <span className="text-sm text-muted">m</span>
            <span className="mx-1 h-5 w-px bg-[var(--border)]" />
            {QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const t = (hours ?? 0) * 60 + (minutes ?? 0) + q.minutes;
                  setHours(Math.floor(t / 60));
                  setMinutes(t % 60);
                }}
              >
                {q.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-x-4">
          <Field label={spread ? "First day" : "Date"}>
            <input
              type="date"
              className="input w-full"
              value={date}
              max={today}
              onChange={(e) => {
                setDate(e.target.value);
                if (!spread || e.target.value > endDate) setEndDate(e.target.value);
              }}
            />
          </Field>
          <Field label="Starting at" hint="only affects the hour-of-day heatmap">
            <input type="time" className="input w-full" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
        </div>

        <label className="flex items-center gap-2 py-1.5 text-xs">
          <input type="checkbox" className="h-4 w-4" checked={spread} onChange={(e) => setSpread(e.target.checked)} />
          <span>Spread it evenly across a range of days</span>
        </label>

        {spread && (
          <Field label="Last day">
            <input type="date" className="input w-full" value={endDate} min={date} max={today} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        )}

        <Field label="Note" hint="optional">
          <input
            className="input w-full"
            placeholder="e.g. work done before I started tracking"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </Field>

        <div className={cn("mt-1 rounded-md border border-app px-3 py-2 text-xs", plan.error ? "text-danger" : "text-muted")}>
          {plan.error ? (
            plan.error
          ) : totalSeconds <= 0 ? (
            "Set an amount above zero."
          ) : (
            <>
              Adds <span className="font-medium text-fg">{fmtHours(totalSeconds / 3600)}</span>
              {targetName ? (
                <>
                  {" "}
                  to <span className="font-medium text-fg">{targetName}</span>
                </>
              ) : (
                " to the unassigned inbox"
              )}
              {plan.days > 1 ? (
                <>
                  , split across <span className="font-medium text-fg">{plan.days} days</span> ({fmtHours(perDayHours)} per day)
                </>
              ) : (
                <> on {format(parseISO(date), "EEE d MMM yyyy")}</>
              )}
              .
              {heavy && <span className="text-warn"> That is {fmtHours(perDayHours)} in a single day — check the range.</span>}
            </>
          )}
        </div>
        <p className="text-[10px] leading-4 text-muted">
          This records <em>time</em>. Percent complete is separate — set that on the task itself, and the pace chart picks it up.
        </p>
      </div>
    </Modal>
  );
}
