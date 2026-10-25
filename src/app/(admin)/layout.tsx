import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { SIGN_IN_AGAIN } from "@/lib/auth-paths";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { devDataLoaderEnabled } from "@/lib/dev-data/flags";
import { NavigationGuardProvider } from "@/components/navigation-guard";
import { NotificationBell } from "@/components/sidebar/notification-bell";
import { PresencePing } from "@/components/presence-ping";
import { AnalyticsIdentify } from "@/components/analytics-identify";
import { AppShell } from "@/components/shell/app-shell";
import { buildNav, settingsLinks } from "@/components/shell/nav";

// The signed-in frame: sidebar, top bar, and the page. What the sidebar shows
// per role and feature flag lives in components/shell/nav.ts.

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect(SIGN_IN_AGAIN);
  const isAdmin = role === "ADMIN";
  // Kill switch for the test-phase review machinery (My tasks + badge).
  const followThrough = reviewFollowThroughEnabled();
  const groups = buildNav(isAdmin, {
    followThrough,
    changeRequests: changeRequestsEnabled(),
    devData: devDataLoaderEnabled(),
  });

  return (
    // The guard provider lives at the layout so pages can intercept exits
    // through links they don't own (the sidebar). See navigation-guard.tsx.
    <NavigationGuardProvider>
      <PresencePing />
      <AnalyticsIdentify userId={session.user.id} role={role} />
      <AppShell
        groups={groups}
        settings={isAdmin ? settingsLinks(changeRequestsEnabled()) : null}
        homeHref={isAdmin || !followThrough ? "/styles" : "/dashboard"}
        user={{ name: session.user.name || session.user.email, email: session.user.email }}
        // The bell is Monday-import status — an admin surface.
        bell={isAdmin ? <NotificationBell align="end" /> : null}
      >
        {children}
      </AppShell>
    </NavigationGuardProvider>
  );
}
