"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

const GAP = 6;

/** Whether CSS anchor positioning can keep the panel under its button. Read in events only. */
const anchorsWork = () => typeof CSS !== "undefined" && CSS.supports("anchor-name", "--a");

/**
 * A button and the panel it opens, floating under it on the page's top layer:
 * nothing in the page moves when it opens, and no scrolling box (the sidebar's)
 * clips it. The browser's Popover API does the work — click, Enter or Space
 * open and close it; a click elsewhere and Escape close it. CSS anchor
 * positioning keeps it under the button (above when there's no room below);
 * where a browser has none, it's placed from the button's box. Following a
 * link in it, any navigation, and Tab moving past it all close it. Look and
 * motion: `.popover` in globals.css.
 */
export function Popover({
  anchor,
  className,
  trigger,
  label,
  align = "start",
  onOpenChange,
  children,
}: {
  /** The CSS anchor name that ties the panel to its button, unique on the page. */
  anchor: `--${string}`;
  /** The button's classes. */
  className: string;
  /** What the button shows. */
  trigger: ReactNode;
  /** The button's accessible name, when its content doesn't say what it opens. */
  label?: string;
  /** Line the panel up with the button's left edge (start) or right edge (end). */
  align?: "start" | "end";
  /** Told each time the panel opens or closes. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const hide = () => close(panel.current);

  // Any navigation closes it.
  const pathname = usePathname();
  useEffect(() => close(panel.current), [pathname]);

  // Without anchor positioning: placed from the button's box, and kept there while open.
  useEffect(() => {
    if (!open || anchorsWork()) return;
    const follow = () => place(button.current, panel.current, align);
    follow();
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, { capture: true });
    };
  }, [open, align]);

  return (
    <div
      onBlur={(e) => {
        // Tab moved on past the panel: close it rather than cover what has focus now.
        const next = e.relatedTarget;
        if (next instanceof Node && !e.currentTarget.contains(next)) hide();
      }}
    >
      <button
        ref={button}
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        style={{ anchorName: anchor } as CSSProperties}
        className={className}
      >
        {trigger}
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        data-align={align}
        style={{ positionAnchor: anchor } as CSSProperties}
        onBeforeToggle={(e) => {
          if (e.newState === "open" && !anchorsWork()) place(button.current, panel.current, align);
        }}
        onToggle={(e) => {
          setOpen(e.newState === "open");
          onOpenChange?.(e.newState === "open");
        }}
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest("a")) hide();
        }}
        className="popover border-line bg-surface/85 mono:bg-surface text-ink rounded-[10px] border p-1 shadow-[var(--shadow-lift)] backdrop-blur-xl"
      >
        {children}
      </div>
    </div>
  );
}

function close(panel: HTMLElement | null) {
  if (panel?.matches(":popover-open")) panel.hidePopover();
}

/** Puts the panel under the button, or above it when it doesn't fit below. */
function place(button: HTMLElement | null, panel: HTMLElement | null, align: "start" | "end") {
  if (!button || !panel) return;
  const box = button.getBoundingClientRect();
  const height = panel.offsetHeight;
  const below = box.bottom + GAP;
  const above = box.top - GAP - height;
  const fitsBelow = below + height <= window.innerHeight || above < 0;
  panel.style.top = `${fitsBelow ? below : above}px`;
  if (align === "end") {
    panel.style.left = "auto";
    panel.style.right = `${window.innerWidth - box.right}px`;
  } else {
    panel.style.left = `${box.left}px`;
  }
  panel.style.minWidth = `${box.width}px`;
}
