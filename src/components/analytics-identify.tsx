"use client";

// Links analyticsOS's visitor to the signed-in user. Mounted once in the admin
// layout, so it runs on load when a session already exists and again after a
// sign-in lands there. A no-op when the script isn't loaded (no
// NEXT_PUBLIC_ANALYTICS_KEY). Renders nothing.
//
// Sign-out calls resetUser() — see SignOutButton. What gets sent, and the
// custom events, live in @/lib/analytics.

import { useEffect } from "react";
import { identifyUser } from "@/lib/analytics";

export function AnalyticsIdentify({ userId, role }: { userId: string; role: string | null }) {
  useEffect(() => {
    identifyUser(userId, role);
  }, [userId, role]);

  return null;
}
