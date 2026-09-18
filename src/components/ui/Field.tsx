import { useEffect, useState, type ReactNode } from "react";

export function Field({ label, hint, children, inline, className = "" }: { label: string; hint?: string; children: ReactNode; inline?: boolean; className?: string }) {
  return (
    <label className={`${inline ? "flex items-center justify-between gap-4 py-1.5" : "block py-1.5"} ${className}`}>
      <span className="block text-xs font-medium text-muted">
        {label}
        {hint && <span className="ml-1 font-normal opacity-70">· {hint}</span>}
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
