"use client";

// Links analyticsOS's visitor to the signed-in user. Mounted once in the admin
// layout, so it runs on load when a session already exists and again after a
// sign-in lands there. Identifies by the internal user id with the role as the
// only trait — never the email or name (analyticsOS privacy rule). A no-op when
// the script isn't loaded (no NEXT_PUBLIC_ANALYTICS_KEY). Renders nothing.
//
// Sign-out calls window.aos?.("reset") — see SignOutButton. Custom events and
// the window.aos type live in @/lib/analytics.

import { useEffect } from "react";

export function AnalyticsIdentify({ userId, role }: { userId: string; role: string | null }) {
  useEffect(() => {
    window.aos?.("identify", userId, { role: role ?? "NONE" });
  }, [userId, role]);

  return null;
}
