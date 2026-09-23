import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface InlineNumberHandle {
  /** open the editor with the value selected (the tree's "E" shortcut) */
  edit(): void;
}

/**
 * A number that reads as plain text and turns into an input on click. The tree
 * showed a slider, a percent box and an effort box on every leaf; as text the
 * columns line up with the group rows and only the value being edited has a frame.
 */
export const InlineNumber = forwardRef<
  InlineNumberHandle,
  {
    value: number | null;
    /** text shown at rest */
    display: string;
    /** called with the trimmed text on Enter or blur; "" means cleared */
    onCommit: (raw: string) => void;
    min?: number;
    max?: number;
    step?: number | "any";
    placeholder?: string;
    className?: string;
    inputClassName?: string;
    ariaLabel: string;
  }
>(function InlineNumber({ value, display, onCommit, min, max, step, placeholder, className, inputClassName, ariaLabel }, ref) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Escape unmounts the input; a blur fired on the way out must not save */
  const cancelled = useRef(false);

  const open = () => {
    cancelled.current = false;
    setDraft(value === null ? "" : String(value));
  };
  useImperativeHandle(ref, () => ({ edit: open }));

  const commit = (raw: string) => {
    setDraft(null);
    if (cancelled.current) return;
    if (raw.trim() !== (value === null ? "" : String(value))) onCommit(raw.trim());
  };

  if (draft === null) {
    return (
      <button
        type="button"
        className={cn("inline-num", className)}
        data-empty={value === null}
        aria-label={`${ariaLabel}: ${display}. Click to edit`}
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {display}
      </button>
    );
  }

  return (
    <input
      autoFocus
      type="number"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={cn("input py-0.5 text-right", inputClassName)}
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(null);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
});
