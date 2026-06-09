"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Pill-style on/off toggle. Use anywhere a checkbox carries a boolean
// "is this on?" semantic — output enabled, customer active, supplier
// attached, etc. Renders as a button (so it tabs / hits ENTER) and stays
// accessible via `role="switch"` + `aria-checked`.
//
// Usage:
//   <Toggle checked={enabled} onChange={setEnabled} label="Active" />
//   <Toggle checked={enabled} onChange={setEnabled} size="sm" />
//
// Variants:
//   size: "sm" (default) | "md"
//   onLabel / offLabel: optional override for the inline text
//     (defaults: ON / OFF — use "" to hide and show just the pill)
type ToggleSize = "sm" | "md";

type ToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: ToggleSize;
  onLabel?: string;
  offLabel?: string;
  className?: string;
  // Use when the toggle's purpose is non-obvious from surrounding text.
  ariaLabel?: string;
};

const SIZE_CLASSES: Record<ToggleSize, { track: string; thumb: string; translate: string; text: string }> = {
  sm: {
    track: "h-4 w-7",
    thumb: "h-3 w-3",
    translate: "translate-x-3",
    text: "text-[10px]",
  },
  md: {
    track: "h-5 w-9",
    thumb: "h-4 w-4",
    translate: "translate-x-4",
    text: "text-xs",
  },
};

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = "sm",
  onLabel = "ON",
  offLabel = "OFF",
  className,
  ariaLabel,
}: ToggleProps) {
  const sz = SIZE_CLASSES[size];

  return (
    <label
      className={cn(
        "inline-flex select-none items-center gap-2",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1",
          sz.track,
          checked ? "bg-zinc-900" : "bg-zinc-200",
        )}
      >
        <span
          className={cn(
            "inline-block translate-x-0.5 transform rounded-full bg-white shadow-sm transition-transform",
            sz.thumb,
            checked && sz.translate,
          )}
        />
      </button>
      {(label || (onLabel && offLabel)) && (
        <span className={cn("font-medium", sz.text, checked ? "text-zinc-900" : "text-zinc-500")}>
          {label ?? (checked ? onLabel : offLabel)}
        </span>
      )}
    </label>
  );
}
