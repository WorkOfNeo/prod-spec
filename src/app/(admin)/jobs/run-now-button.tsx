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
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
      >
        {pending ? "Running…" : "Run pending jobs now"}
      </button>
      {result && <span className="text-xs text-zinc-600">{result}</span>}
    </div>
  );
}
