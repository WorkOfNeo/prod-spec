"use client";

// Presence heartbeat. Mounted once in the admin layout, so it stays alive across
// soft navigations between admin pages (the layout doesn't remount). Fires a
// fire-and-forget POST shortly after the page has loaded (not alongside the
// page's own requests), every PING_INTERVAL_MS, and whenever the tab becomes
// visible again — keeping the user's lastSeenAt fresh while a tab is open,
// hidden or not (pauseWhileHidden: false; the /admin "online" view is about
// open tabs, and one ping a minute from a background tab costs nothing). Stops
// when the tab/window closes, so lastSeenAt goes stale and the user drops to
// "offline" after the /admin online window. Renders nothing.

import { useVisiblePoll } from "@/lib/use-visible-poll";

const PING_INTERVAL_MS = 60_000;

export function PresencePing() {
  useVisiblePoll(
    () => {
      void fetch("/api/admin/presence/ping", { method: "POST", keepalive: true }).catch(() => {});
    },
    PING_INTERVAL_MS,
    { pauseWhileHidden: false },
  );

  return null;
}
