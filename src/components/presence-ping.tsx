"use client";

// Presence heartbeat. Mounted once in the admin layout, so it stays alive across
// soft navigations between admin pages (the layout doesn't remount). Fires a
// fire-and-forget POST on mount, every PING_INTERVAL_MS, and whenever the tab
// becomes visible again — keeping the user's lastSeenAt fresh while a tab is
// open. Stops when the tab/window closes, so lastSeenAt goes stale and the user
// drops to "offline" after the /admin online window. Renders nothing.

import { useEffect } from "react";

const PING_INTERVAL_MS = 60_000;

export function PresencePing() {
  useEffect(() => {
    let stopped = false;
    const ping = () => {
      if (stopped) return;
      void fetch("/api/admin/presence/ping", { method: "POST", keepalive: true }).catch(() => {});
    };
    ping(); // mark online immediately
    const interval = setInterval(ping, PING_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
