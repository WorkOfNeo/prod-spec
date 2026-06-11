"use client";

// Returning to the dashboard tab should show current truth — a job that
// settled in another tab (or by another reviewer) must drop off without a
// manual reload. No realtime plumbing; a focus refresh is enough.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);
  return null;
}
