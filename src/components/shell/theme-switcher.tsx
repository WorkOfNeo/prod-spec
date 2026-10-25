"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { applyTheme, currentTheme, readThemeCookie, THEME_EVENT, THEMES, type Theme } from "@/lib/theme";

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

/** Light · Dark · Black & white, as a segmented control. */
export function ThemeSwitcher() {
  const theme = useSyncExternalStore<Theme>(subscribe, currentTheme, () => "light");

  // Re-apply after React's dev remount clears <html> attributes; a no-op in production.
  useLayoutEffect(() => {
    const saved = readThemeCookie();
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  }, []);

  return (
    <div role="group" aria-label="Theme" className="bg-seg ring-seg-line flex gap-0.5 rounded-[9px] p-[3px] ring-1 ring-inset">
      {THEMES.map((t) => {
        const on = t.key === theme;
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={on}
            onClick={() => applyTheme(t.key)}
            className={`h-7 flex-1 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors duration-150 ${
              on ? "bg-seg-on text-seg-on-ink shadow-pop" : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
