import { useEffect, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * `hint` is a word or two shown after the label (a unit, a count); `help` is an
 * explanation, kept behind an info mark so a narrow pane of fields does not
 * turn into a page of wrapped sentences.
 */
export function Field({ label, hint, help, children, inline, className = "" }: { label: string; hint?: string; help?: string; children: ReactNode; inline?: boolean; className?: string }) {
  return (
    <label className={`${inline ? "flex items-center justify-between gap-4 py-1.5" : "block py-1.5"} ${className}`}>
      <span className="flex items-center gap-1 text-xs font-medium text-muted">
        <span className="truncate">{label}</span>
        {hint && <span className="shrink-0 font-normal opacity-70">· {hint}</span>}
        {help && <InfoTip text={help} />}
      </span>
      <div className={inline ? "" : "mt-1"}>{children}</div>
    </label>
  );
}

/**
 * Number field that commits on blur or Enter (not per keystroke), so typing
 * "40" produces one write instead of two and never fights with re-renders.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className = "input w-28",
  allowNull,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  className?: string;
  allowNull?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = (raw: string) => {
    setDraft(null);
    const t = raw.trim();
    if (t === "") {
      if ((allowNull ? null : 0) !== value) onChange(allowNull ? null : 0);
      return;
    }
    let n = Number(t);
    if (!Number.isFinite(n)) return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (n !== value) onChange(n);
  };
  return (
    <input
      type="number"
      className={className}
      value={draft ?? (value ?? "")}
      min={min}
      max={max}
      step={step ?? "any"}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") {
          e.preventDefault();
          commit(el.value);
          el.blur();
        } else if (e.key === "Escape") {
          setDraft(null);
          el.blur();
        }
      }}
    />
  );
}

/** Small info mark whose text shows on hover and is read out by screen readers. */
export function InfoTip({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 cursor-help text-muted opacity-60 hover:opacity-100 ${className}`} title={text} aria-label={text} role="img">
      <Info size={12} />
    </span>
  );
}
