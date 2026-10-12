"use client";

// Returning to the dashboard tab should show current truth — a job that
// settled in another tab (or by another reviewer) must drop off without a
// manual reload. No realtime plumbing; a focus refresh is enough.
//
// But a refresh re-runs the whole page server-side, and focus fires on every
// alt-tab and devtools click — so at most one per REFRESH_MIN_GAP_MS. A focus
// inside that window isn't dropped: it schedules one refresh for when the
// window ends (skipped if the tab is hidden by then — the next focus is due
// at once), so the page still catches up.

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { decidePoll } from "@/lib/poll-schedule";

const REFRESH_MIN_GAP_MS = 30_000;

export function RefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    let lastRefreshAt: number | null = null;
    let deferred: ReturnType<typeof setTimeout> | undefined;

    const refreshIfDue = () => {
      const now = performance.now();
      const { run, nextInMs } = decidePoll({
        now,
        lastRunAt: lastRefreshAt,
        intervalMs: REFRESH_MIN_GAP_MS,
        hidden: document.hidden,
      });
      if (run) {
        clearTimeout(deferred);
        deferred = undefined;
        lastRefreshAt = now;
        router.refresh();
      } else if (nextInMs !== null && deferred === undefined) {
        deferred = setTimeout(() => {
          deferred = undefined;
          refreshIfDue();
        }, nextInMs);
      }
    };

    window.addEventListener("focus", refreshIfDue);
    return () => {
      window.removeEventListener("focus", refreshIfDue);
      clearTimeout(deferred);
    };
  }, [router]);
  return null;
}
