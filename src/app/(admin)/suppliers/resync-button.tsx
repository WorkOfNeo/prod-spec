"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ResyncSupplierButton({ supplierId }: { supplierId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/suppliers/${supplierId}/resync`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {err && <span className="text-xs text-red-600">{err}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {pending ? "…" : "Re-sync"}
      </button>
    </div>
  );
}
