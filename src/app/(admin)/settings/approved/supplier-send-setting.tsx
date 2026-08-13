"use client";

import { useState } from "react";
import { Toggle } from "@/components/toggle";

// Master switch for the nightly supplier-send system. Optimistic toggle that
// PATCHes /api/admin/settings/supplier-batch-send and reverts on failure.
// OFF by default: the queue still fills + shows below, but nothing pushes or
// sends until this is on.
export function SupplierSendSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(next: boolean) {
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/supplier-batch-send", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Failed to save (${res.status})`);
      }
    } catch (e) {
      setEnabled(!next);
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`rounded-lg border p-5 ${
        enabled ? "border-emerald-300 bg-emerald-50/40" : "border-amber-300 bg-amber-50/40"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Automatic supplier sending</h2>
          <p className="mt-1 text-sm text-zinc-600">
            When <strong>on</strong>, approved outputs are pushed to the supplier&rsquo;s SharePoint
            folder as soon as they&rsquo;re approved, and the midnight job emails each supplier one
            digest of everything waiting for them. When <strong>off</strong> (the default), the
            queue below still fills so you can see exactly what would be sent &mdash; but{" "}
            <strong>nothing is pushed and no email is sent</strong>.
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <Toggle
          checked={enabled}
          onChange={update}
          disabled={saving}
          size="md"
          ariaLabel="Automatic supplier sending"
        />
      </div>
      <div className="mt-3 text-xs text-zinc-500">
        {saving
          ? "Saving…"
          : enabled
            ? "Sending is ON — approved outputs push to SharePoint and suppliers are emailed at midnight."
            : "Sending is OFF — capture + preview only. Nothing leaves the building."}
      </div>
    </div>
  );
}

// Backfill PO cutoff (Option A / WS3). The recurring sweep reconciles styles
// approved BEFORE queue capture existed into the queue — but only at/above
// this PO, so flipping the system on can't blast suppliers with the archive.
// Unset ⇒ follows the generation cutoff; whole chain unset ⇒ backfill idle.
export function SupplierSendCutoff({
  initialExplicit,
  effective,
  generation,
}: {
  initialExplicit: number | null;
  effective: number | null;
  generation: number | null;
}) {
  const [value, setValue] = useState(initialExplicit === null ? "" : String(initialExplicit));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(cutoff: number | null) {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/settings/supplier-send-min-po", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cutoff }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; effective?: number | null };
      if (!res.ok) throw new Error(j.error ?? `Failed to save (${res.status})`);
      setMsg(
        cutoff === null
          ? j.effective != null
            ? `Cleared — following the generation cutoff (PO ≥ ${j.effective}).`
            : "Cleared — no cutoff anywhere, so every order is deliverable."
          : `Saved — only PO ≥ ${cutoff} is delivered to suppliers.`,
      );
      if (cutoff === null) setValue("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const followingHint =
    initialExplicit === null
      ? effective != null
        ? `Following the generation cutoff: PO ≥ ${effective}.`
        : "No cutoff set anywhere — every order is deliverable until you set one."
      : null;

  return (
    <div className="rounded-lg border border-zinc-200 p-5">
      <h2 className="text-sm font-semibold text-zinc-900">Deliver from PO</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Orders below this PO number are <strong>never</strong> delivered to a supplier — not queued,
        not uploaded to a supplier folder, not emailed in the nightly digest. It applies to every
        path, including cover pages (which otherwise ship regardless of approval) and the backfill
        that reconciles pre-existing approvals into the queue.
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        A style with no readable PO number is treated as below the cutoff. To deliver an older order
        anyway, lower the cutoff or use the per-style push button on the style page.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={generation != null ? `${generation} (generation cutoff)` : "e.g. 63144"}
          className="w-44 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm tabular-nums"
        />
        <button
          type="button"
          disabled={saving || value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) <= 0}
          onClick={() => save(Number(value))}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => save(null)}
          className="rounded-md px-2 py-1.5 text-xs text-zinc-500 underline disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      <div className="mt-2 text-xs text-zinc-500">{saving ? "Saving…" : (msg ?? followingHint)}</div>
    </div>
  );
}
