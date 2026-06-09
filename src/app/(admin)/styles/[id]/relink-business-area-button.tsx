"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Small client island for the "Link to <BA>" button on the prod-spec
// tab. Sits inside an otherwise server-rendered block — kept in its own
// file so we don't have to make the whole tab "use client".
export function RelinkBusinessAreaButton({
  styleId,
  candidate,
}: {
  styleId: string;
  candidate: { id: string; name: string; mondayValue: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function relink() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/relink-business-area`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex items-center gap-3">
      <button
        type="button"
        onClick={relink}
        disabled={busy}
        className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50"
      >
        {busy ? "Linking…" : `Link to "${candidate.name}" Business Area`}
      </button>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </div>
  );
}
