"use client";

import { useEffect, useState } from "react";
import { errorOf, getJson } from "./shared";

export type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

// Fetch once per URL and remember the answer for the life of the component.
// Not in the map yet = loading; an aborted fetch (the draft was switched
// away from) stores nothing, so coming back fetches again.
export function useCachedFetch<T>(url: string | null): Load<T> | null {
  const [results, setResults] = useState<Record<string, Load<T>>>({});
  const known = url !== null && url in results;
  useEffect(() => {
    if (!url || known) return;
    const controller = new AbortController();
    getJson<T>(url, controller.signal)
      .then((res) => {
        const load: Load<T> = res.ok ? { state: "ready", data: res.data } : { state: "error", message: errorOf(res.data) };
        setResults((prev) => ({ ...prev, [url]: load }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [url, known]);
  return url ? (results[url] ?? { state: "loading" }) : null;
}
