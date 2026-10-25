"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RunNowButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function onClick() {
    setResult(null);
    setPending(true);
    try {
      const res = await fetch("/api/jobs/run", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(`processed ${body.processed}, failed ${body.failed}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Running…" : "Run pending jobs now"}
      </button>
      {result && <span className="text-xs text-muted">{result}</span>}
    </div>
  );
}
