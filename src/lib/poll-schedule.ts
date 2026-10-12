// The timing rule behind the sidebar pollers, the presence heartbeat
// (use-visible-poll.ts) and the dashboard's refresh-on-focus — kept free of
// timers and the DOM so it can be tested on its own.
//
// Asked whenever a run might be due: a timer firing, the tab turning visible,
// the window regaining focus. By default a hidden tab never runs and arms no
// timer — the next "visible" resumes it, so a background tab costs the server
// nothing. Otherwise it runs when there has been no run yet or the last one
// is at least intervalMs old, and says how long until it is worth asking
// again.
//
// pauseWhileHidden: false is the presence heartbeat's rule, where an open tab
// counts as online even in the background: it keeps its interval while
// hidden, and turning visible runs at once regardless of the last run (a
// background tab's timers may have been throttled by the browser).

export type PollDecision = {
  run: boolean;
  // Delay before asking again; null = don't (paused while hidden).
  nextInMs: number | null;
};

export function decidePoll({
  now,
  lastRunAt,
  intervalMs,
  hidden,
  pauseWhileHidden = true,
  becameVisible = false,
}: {
  now: number;
  lastRunAt: number | null;
  intervalMs: number;
  hidden: boolean;
  pauseWhileHidden?: boolean;
  // The ask comes from the tab turning visible.
  becameVisible?: boolean;
}): PollDecision {
  if (hidden && pauseWhileHidden) return { run: false, nextInMs: null };
  if (lastRunAt === null) return { run: true, nextInMs: intervalMs };
  if (becameVisible && !pauseWhileHidden) return { run: true, nextInMs: intervalMs };
  const elapsed = now - lastRunAt;
  // A clock that went backwards counts as due rather than parking the
  // poller for however far it jumped.
  if (elapsed >= intervalMs || elapsed < 0) return { run: true, nextInMs: intervalMs };
  return { run: false, nextInMs: intervalMs - elapsed };
}
