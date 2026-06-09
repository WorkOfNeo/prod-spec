"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// One-click bootstrap for the Monday webhook subscriptions. POSTs
// { all: true } to /api/admin/webhooks, which registers the default event
// set (create_item, change_column_value, item_archived, item_deleted) on the
// Pre-Order, Styles, Customers and Suppliers boards. Additive only — the
// endpoint registers what's missing and never deletes (project rule), so
// this is safe to click repeatedly ("refresh").
type RegisterResult = {
  error?: string;
  results?: Array<{
    boardId: string;
    created?: Array<{ event: string }>;
    skipped?: string[];
    foreign?: unknown[];
  }>;
};

export function RegisterWebhooksButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function register() {
    setPending(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const j = (await res.json().catch(() => ({}))) as RegisterResult;
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const sum = (pick: (r: NonNullable<RegisterResult["results"]>[number]) => number) =>
        (j.results ?? []).reduce((n, r) => n + pick(r), 0);
      const created = sum((r) => r.created?.length ?? 0);
      const skipped = sum((r) => r.skipped?.length ?? 0);
      const foreign = sum((r) => r.foreign?.length ?? 0);
      setMsg(
        `Registered ${created} new · ${skipped} already present${
          foreign ? ` · ${foreign} unmanaged on Monday (left untouched)` : ""
        }.`,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to register");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={register}
        disabled={pending}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Registering…" : "Register / refresh webhooks"}
      </button>
      {msg ? <span className="max-w-xs text-right text-xs text-emerald-600">{msg}</span> : null}
      {error ? <span className="max-w-xs text-right text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
