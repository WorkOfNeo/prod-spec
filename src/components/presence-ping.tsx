"use client";

// Presence heartbeat. Mounted once in the admin layout, so it stays alive across
// soft navigations between admin pages (the layout doesn't remount). Fires a
// fire-and-forget POST shortly after the page has loaded, every
// PING_INTERVAL_MS while the tab is visible, and on coming back to a tab whose
// last ping is older than that — keeping the user's lastSeenAt fresh while a
// tab is open and in view. Stops when the tab is hidden or closed, so
// lastSeenAt goes stale and the user drops to "offline" after the /admin online
// window. Scheduling: useVisiblePoll. Renders nothing.

import { useVisiblePoll } from "@/lib/use-visible-poll";

const PING_INTERVAL_MS = 60_000;

export function PresencePing() {
  useVisiblePoll(() => {
    void fetch("/api/admin/presence/ping", { method: "POST", keepalive: true }).catch(() => {});
  }, PING_INTERVAL_MS);

  return null;
}
