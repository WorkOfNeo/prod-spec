"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Two-way bind a single free-text search box to a URL query param, so the
 * value survives back-navigation (and is shareable / refreshable).
 *
 * Writes with a *shallow* `window.history.replaceState` rather than a router
 * navigation: these tables fetch every row server-side once and filter in the
 * browser, so re-running the page on each keystroke would be wasteful (and on
 * /styles, an expensive ~4k-row re-query). The shallow write keeps the page
 * mounted while still syncing `useSearchParams`. See
 * node_modules/next/dist/docs ▸ guides/single-page-applications
 * ("Shallow routing on the client"). `replaceState` (not push) keeps each
 * keystroke from stacking a history entry — Back still returns to the page
 * *before* this list, with the latest filter preserved on it.
 *
 * The param is read once, on mount, to seed the value (via `useSearchParams`
 * so it's SSR-safe — `window` isn't available during render); thereafter the
 * component state is the source of truth and changes flow state → URL. Other
 * query params are left untouched, so this is safe on pages that already carry
 * params (e.g. /po-eans?status=…).
 */
export function useUrlSearchState(key: string): [string, (value: string) => void] {
  const searchParams = useSearchParams();
  // Lazy initialiser → reads the param exactly once, on mount.
  const [value, setValue] = useState(() => searchParams.get(key) ?? "");

  useEffect(() => {
    // Read the live URL (not the mount-time snapshot) so concurrent params
    // added by other UI on the page are preserved.
    const params = new URLSearchParams(window.location.search);
    if (value.trim()) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, [key, value]);

  return [value, setValue];
}
