"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RerunButton({ styleId, disabled }: { styleId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/rerun`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
      >
        {pending ? "Re-running…" : "Re-run"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
