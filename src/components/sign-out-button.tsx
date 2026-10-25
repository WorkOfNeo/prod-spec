"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        // Forget the analyticsOS user so the next person on this browser
        // starts as a new visitor (see AnalyticsIdentify).
        window.aos?.("reset");
        router.push("/login");
        router.refresh();
      }}
      className="mt-2 text-xs text-zinc-600 underline hover:text-zinc-900"
    >
      Sign out
    </button>
  );
}
