"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Preview = {
  empty: boolean;
  to: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
};

// "Preview email" per supplier — fetches the exact digest that would be sent at
// midnight (shared builder, so preview == send) and shows it in a dialog.
export function SupplierPreviewButton({
  supplierId,
  supplierName,
}: {
  supplierId: string | null;
  supplierName: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/admin/supplier-send/preview?supplierId=${supplierId ?? "none"}`);
      const body = (await res.json().catch(() => ({}))) as Preview & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setPreview(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load preview");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={load}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
      >
        Preview email
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-zinc-900">Midnight digest — {supplierName}</h3>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {loading
                    ? "Building preview…"
                    : preview?.empty
                      ? "Nothing queued for this supplier."
                      : preview
                        ? `To: ${preview.to ?? "— no email on file"}`
                        : ""}
                </p>
                {!loading && preview && !preview.empty ? (
                  <p className="mt-0.5 truncate text-xs font-medium text-zinc-700">{preview.subject}</p>
                ) : null}
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 underline">
                close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-50 p-4">
              {error ? (
                <p className="text-sm text-red-600">{error}</p>
              ) : loading ? (
                <p className="text-sm text-zinc-500">Loading…</p>
              ) : preview?.empty ? (
                <p className="text-sm text-zinc-500">No approved outputs are queued for this supplier.</p>
              ) : preview?.html ? (
                <iframe
                  title="Email preview"
                  srcDoc={preview.html}
                  className="h-[55vh] w-full rounded-md border border-zinc-200 bg-white"
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// "Run the supplier batch now" — triggers the same cron path manually (session
// auth). Honours the master flag: dry run when off. Handy for testing without
// waiting for midnight.
export function RunBatchNowButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/cron/supplier-send?manual=1`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        supplierCount?: number;
        sentCount?: number;
        dryRun?: boolean;
      };
      if (!res.ok) {
        setMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setMsg(
        body.dryRun
          ? `Dry run — ${body.supplierCount ?? 0} supplier(s) would receive a digest (sending is off).`
          : `Ran — ${body.sentCount ?? 0} email(s) sent across ${body.supplierCount ?? 0} supplier(s) (${body.status}).`,
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Running…" : enabled ? "Run batch now" : "Run batch now (dry run)"}
      </button>
      {msg ? <span className="text-xs text-zinc-500">{msg}</span> : null}
    </div>
  );
}
