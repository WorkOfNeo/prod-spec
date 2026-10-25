"use client";

import { useEffect, type HTMLAttributes, type ReactNode } from "react";

// A centred dialog over a dimmed page. Clicking the backdrop or pressing
// Escape closes it (unless `locked`, e.g. while a request is in flight).
// Extra props go on the panel — that's where a drop target attaches.

export function Dialog({
  onClose,
  locked = false,
  label,
  className = "",
  children,
  ...panel
}: {
  onClose: () => void;
  locked?: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !locked) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(15_17_21/0.4)] p-4"
      onClick={() => {
        if (!locked) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      // Swallow drops that miss the panel so the browser doesn't open the file.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        {...panel}
        onClick={(e) => e.stopPropagation()}
        className={`reveal border-line bg-surface text-ink w-full max-w-lg rounded-xl border p-5 shadow-[var(--shadow-lift)] ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({ title, context }: { title: ReactNode; context?: ReactNode }) {
  return (
    <div>
      <h3 className="text-ink text-[14px] font-semibold">{title}</h3>
      {context ? <p className="text-muted mt-0.5 text-[12px]">{context}</p> : null}
    </div>
  );
}
