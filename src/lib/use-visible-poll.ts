"use client";

import { useEffect, useEffectEvent } from "react";
import { decidePoll } from "./poll-schedule";

// Upper bound on how long the first call waits for an idle moment once the
// page has loaded (and the delay outright where requestIdleCallback is
// missing, e.g. older Safari).
const FIRST_CALL_MAX_WAIT_MS = 1_500;

/**
 * Background polling for the admin layout's sidebar badges and presence
 * heartbeat. Each of them used to fire on mount — alongside the page's own
 * requests on every full load — and then every interval in every open tab,
 * visible or not. Instead:
 *
 * - the first call waits until the page has loaded and the browser is idle
 *   (or FIRST_CALL_MAX_WAIT_MS, whichever comes first);
 * - nothing is sent while the tab is hidden;
 * - turning visible again calls at once if the last call is older than the
 *   interval, otherwise picks up where the interval left off.
 *
 * Timing lives in decidePoll (poll-schedule.ts). `run` gets a signal that
 * aborts on unmount; it may be a fresh closure each render.
 */
export function useVisiblePoll(run: (signal: AbortSignal) => void, intervalMs: number): void {
  const onPoll = useEffectEvent(run);

  useEffect(() => {
    const controller = new AbortController();
    let lastRunAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;

    const step = () => {
      clearTimeout(timer);
      timer = undefined;
      // performance.now() is monotonic — a wall-clock change can't stall or
      // double up the cadence.
      const now = performance.now();
      const { run: due, nextInMs } = decidePoll({
        now,
        lastRunAt,
        intervalMs,
        hidden: document.hidden,
      });
      if (due) {
        lastRunAt = now;
        onPoll(controller.signal);
      }
      if (nextInMs !== null) timer = setTimeout(step, nextInMs);
    };

    const cancelStart = afterPageLoad(() => {
      started = true;
      step();
    });
    // Before the first call is due, visibility changes are left to it.
    const onVisibility = () => {
      if (started) step();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      controller.abort();
      cancelStart();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}

// Call `fn` once the page's load event has fired and the main thread is idle,
// so the first poll doesn't compete with the page's own requests and
// hydration. Returns a cancel function.
function afterPageLoad(fn: () => void): () => void {
  let idleId: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(fn, { timeout: FIRST_CALL_MAX_WAIT_MS });
    } else {
      timeoutId = setTimeout(fn, FIRST_CALL_MAX_WAIT_MS);
    }
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
  return () => {
    window.removeEventListener("load", schedule);
    if (idleId !== undefined) window.cancelIdleCallback(idleId);
    clearTimeout(timeoutId);
  };
}
