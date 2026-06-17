"use client";

// View beacon. Mounting this on a style page IS a view: it fires one
// fire-and-forget POST that appends a StyleView row (who · which style · when ·
// which surface). Powers the admin oversight panel's Views tab.
//
// One row per real open: the useRef guard keeps React's dev strict-mode
// double-invoke (and any post-mount re-render) from double-logging, and because
// only a real navigation — never a <Link> prefetch — mounts a client component,
// an accidental hover can't log a phantom view. Renders nothing.

import { useEffect, useRef } from "react";

export function LogStyleView({
  styleId,
  surface,
}: {
  styleId: string;
  surface: "REVIEW" | "STYLE";
}) {
  const loggedRef = useRef(false);

  useEffect(() => {
    if (loggedRef.current) return;
    loggedRef.current = true;
    void fetch(`/api/admin/styles/${styleId}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface }),
      // Logging must never block or interfere with the page; ignore failures.
      keepalive: true,
    }).catch(() => {});
  }, [styleId, surface]);

  return null;
}
