"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Preview = {
  empty: boolean;
  to: string | null;
  // Synced supplier-contact emails CC'd on the digest.
  cc?: string[];
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
                        ? `To: ${preview.to ?? "— no email on file"}${preview.cc?.length ? ` · CC: ${preview.cc.join(", ")}` : ""}`
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

// "Upload to SharePoint now" — the recurring sweep (?uploadOnly=1) on demand:
// reconcile the backfill window, push every pending upload, send NO email.
// Same session auth as "Run batch now"; a no-op while sending is off.
export function UploadNowButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/cron/supplier-send?uploadOnly=1&manual=1`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        enabled?: boolean;
        uploaded?: number;
        failed?: number;
        skipped?: number;
        reconciled?: { outputsEnqueued?: number; stylesEnqueued?: number };
      };
      if (!res.ok) {
        setMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const backfilled = body.reconciled?.outputsEnqueued ?? 0;
      setMsg(
        body.enabled === false
          ? `Sending is off — ${backfilled} output(s) reconciled into the queue, nothing pushed.`
          : `Done — ${body.uploaded ?? 0} uploaded, ${body.failed ?? 0} failed, ${body.skipped ?? 0} skipped` +
              (backfilled > 0 ? ` (+${backfilled} backfilled into the queue)` : "") +
              `.`,
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
        {busy ? "Uploading…" : enabled ? "Upload to SharePoint now" : "Upload to SharePoint now (off — reconcile only)"}
      </button>
      {msg ? <span className="text-xs text-zinc-500">{msg}</span> : null}
    </div>
  );
}

// Reset "gave up" uploads (3 failed pushes) back to PENDING so the next sweep
// retries them — e.g. after FLC fixes folder permissions.
export function RetryFloatedButton({ floatedCount }: { floatedCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (floatedCount === 0 && !msg) return null;

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/supplier-send/retry-floated`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; reset?: number };
      if (!res.ok) {
        setMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setMsg(`${body.reset ?? 0} upload(s) re-armed — the next sweep retries them.`);
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
        className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
      >
        {busy ? "Re-arming…" : `Retry ${floatedCount} gave-up upload${floatedCount === 1 ? "" : "s"}`}
      </button>
      {msg ? <span className="text-xs text-zinc-500">{msg}</span> : null}
    </div>
  );
}

type BackfillResult = {
  error?: string;
  candidates?: number;
  repushed?: number;
  skipped?: number;
  failed?: number;
  cleanup?: Array<{ styleName: string; oldFolderUrl: string }>;
};

// One-off "Re-consolidate supplier folders" — re-push every already-delivered
// style into the NEW folder naming ("<PO> - <customer> - <supplier> - APPROVED
// LAYOUTS"). Preview-then-apply: the first click dry-runs (resolves scope +
// permissions, writes nothing); "Apply" then does the real push. Bypasses the
// master send toggle (manual push path), so it works even while sending is off.
// Old folders are left in place — the result lists them for manual deletion.
export function BackfillFoldersButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BackfillResult | null>(null);
  const [applied, setApplied] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(dryRun: boolean): Promise<BackfillResult | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/supplier-send/backfill${dryRun ? "?dryRun=1" : ""}`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as BackfillResult;
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return null;
      }
      return body;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    setApplied(null);
    const body = await call(true);
    if (body) setPreview(body);
  }

  async function apply() {
    const body = await call(false);
    if (body) {
      setApplied(body);
      setPreview(null);
      router.refresh();
    }
  }

  const result = applied ?? preview;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={runPreview}
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy && !preview ? "Checking…" : "Re-consolidate supplier folders"}
        </button>
        {preview && !applied ? (
          <button
            type="button"
            onClick={apply}
            disabled={busy || (preview.repushed ?? 0) === 0}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            {busy ? "Applying…" : `Apply — re-push ${preview.repushed ?? 0} style${(preview.repushed ?? 0) === 1 ? "" : "s"}`}
          </button>
        ) : null}
      </div>

      {error ? <span className="text-xs text-red-600">{error}</span> : null}

      {result && !error ? (
        <div className="max-w-2xl rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <div>
            {applied ? "Done — " : "Preview — "}
            <span className="font-medium text-zinc-800">{result.repushed ?? 0}</span>{" "}
            {applied ? "re-pushed" : "would be re-pushed"} of {result.candidates ?? 0} already-pushed
            style(s){" "}
            <span className="text-zinc-400">
              ({result.skipped ?? 0} skipped
              {(result.failed ?? 0) > 0 ? `, ${result.failed} failed` : ""})
            </span>
            .
          </div>
          {applied && result.cleanup && result.cleanup.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-zinc-500">
                {result.cleanup.length} old folder{result.cleanup.length === 1 ? "" : "s"} to delete
                manually
              </summary>
              <ul className="mt-1 space-y-0.5">
                {result.cleanup.map((c, i) => (
                  <li key={i} className="truncate">
                    <span className="text-zinc-500">{c.styleName}</span>{" "}
                    <a
                      href={c.oldFolderUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-600 underline hover:text-zinc-900"
                    >
                      old folder ↗
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
