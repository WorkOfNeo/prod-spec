"use client";

import { useState } from "react";

// Per-style delivery re-check. Every other counter on this page counts output
// SLOTS; this one counts DOCUMENTS against the real SharePoint folder, which is
// the only way a split output losing files to a shared name becomes visible.
// Lazy by design — it costs several Graph round-trips, so it runs on click.

type AuditDoc = { variantKey: string; baseKey: string; name: string; fileName: string; spName: string };
type Collision = {
  spName: string;
  layoutId: string | null;
  layoutName: string | null;
  lost: number;
  docs: Array<{ name: string; variantKey: string }>;
  suggestion: string[] | null;
  fix: string;
  stylesUsingLayout: number;
};
type Audit = {
  status: string;
  message: string;
  folderName: string | null;
  folderUrl: string | null;
  expectedDocs: number;
  distinctNames: number;
  deliveredDocs: number;
  missing: AuditDoc[];
  collisions: Array<{ spName: string; lost: number }>;
  stale: string[];
  unqueued: Array<{ baseKey: string; name: string }>;
};
// Last EAN resolve, carried by the audit route. A wrong barcode is a common
// upstream cause of a delivery that looks complete but is wrong, so the source
// is worth showing next to the file counts.
type EanSummary = {
  at: string;
  status: string;
  source: "po" | "monday" | "none";
  poOutcome: string | null;
  mondayOutcome: string;
  sizesMissingEan: string[];
  sizesMissingCarton: string[];
};
type Resp = {
  audit: Audit;
  collisions: Collision[];
  ean?: EanSummary | null;
  acted?: boolean;
  actions?: string[];
};

export function DeliveryCheck({ styleId, canFixTemplate }: { styleId: string; canFixTemplate: boolean }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState<null | "check" | "repair" | "template">(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function call(method: "GET" | "POST") {
    setBusy(method === "GET" ? "check" : "repair");
    setErr(null);
    setNote(null);
    try {
      const r = await fetch(`/api/admin/styles/${styleId}/delivery-audit`, { method });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
      if (j.acted) {
        setNote(
          j.actions?.length ? `Repaired: ${j.actions.join(", ")}.` : "Nothing needed repairing.",
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "check failed");
    } finally {
      setBusy(null);
    }
  }

  async function applyTemplateFix(layoutId: string) {
    if (
      !confirm(
        "This edits the layout's file-name template, which every style using this layout shares.\n\n" +
          "This style's existing documents are then re-named from the new template and re-uploaded. " +
          "They are NOT re-rendered, so their approvals stay intact.\n\nContinue?",
      )
    )
      return;
    setBusy("template");
    setErr(null);
    setNote(null);
    try {
      const r = await fetch(`/api/admin/output-layouts/${layoutId}/apply-filename-fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setNote(
        j.changed
          ? `File name is now “${j.nextExpression}”. Re-named ${j.renamed} document(s), uploaded ${j.uploaded} slot(s).` +
              (j.stillColliding > 0 ? ` ⚠ ${j.stillColliding} group(s) still collide.` : "") +
              (j.otherStylesAffected > 0
                ? ` ${j.otherStylesAffected} other style(s) use this layout — they keep their current names until re-checked.`
                : "")
          : (j.message ?? "No change was needed."),
      );
      await call("GET");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "fix failed");
    } finally {
      setBusy(null);
    }
  }

  const a = data?.audit;
  const shortfall = a ? a.expectedDocs - a.deliveredDocs : 0;
  const lost = data?.collisions.reduce((n, c) => n + c.lost, 0) ?? 0;

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm font-medium text-zinc-700">Delivery check</span>
          <p className="mt-0.5 text-[11px] text-zinc-400">
            Counts every approved PDF against the files actually in the supplier folder.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => call("GET")}
            disabled={busy != null}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy === "check" ? "Checking…" : "Re-check uploads"}
          </button>
          {/* Any gap, not just missing files: a slot whose documents collide has
              nothing "missing" (the shared name IS in the folder) but is still
              repairable — re-naming from the current template separates them. */}
          {a && a.status === "gaps" ? (
            <button
              type="button"
              onClick={() => call("POST")}
              disabled={busy != null}
              className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {busy === "repair" ? "Repairing…" : "Repair & upload"}
            </button>
          ) : null}
        </div>
      </div>

      {err ? <p className="mt-2 text-xs text-rose-700">⚠ {err}</p> : null}
      {note ? <p className="mt-2 text-xs text-emerald-700">✓ {note}</p> : null}

      {a ? (
        <div className="mt-3 space-y-2 text-xs">
          {/* The headline number: documents, not slots. */}
          <div
            className={`rounded-md border px-3 py-2 ${
              a.status === "ok"
                ? "border-emerald-200 bg-emerald-50/60 text-emerald-800"
                : a.status === "gaps"
                  ? "border-amber-200 bg-amber-50/60 text-amber-900"
                  : "border-zinc-200 bg-zinc-50 text-zinc-600"
            }`}
          >
            {a.expectedDocs > 0 ? (
              <div className="font-medium">
                {a.deliveredDocs} of {a.expectedDocs} approved document(s) reached the supplier
                {a.distinctNames < a.expectedDocs ? (
                  <> — {a.expectedDocs} documents share only {a.distinctNames} file name(s)</>
                ) : null}
              </div>
            ) : null}
            <div className={a.expectedDocs > 0 ? "mt-0.5" : ""}>{a.message}</div>
            {a.folderUrl ? (
              <a
                href={a.folderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block underline hover:text-zinc-950"
              >
                Open “{a.folderName}” ↗
              </a>
            ) : null}
          </div>

          {/* Collisions — the case no retry can fix. */}
          {data!.collisions.map((c) => (
            <div key={c.spName} className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-rose-900">
              <div className="font-medium">
                ⚠ {c.lost} document(s) can never be delivered
                {c.layoutName ? <> — {c.layoutName}</> : null}
              </div>
              <p className="mt-1">
                {c.docs.length} documents all resolve to <code className="rounded bg-white/70 px-1">{c.spName}</code>, so
                each upload overwrites the last.
              </p>
              <ul className="mt-1 list-disc pl-4 text-[11px] text-rose-800/90">
                {c.docs.map((d) => (
                  <li key={d.variantKey}>{d.name}</li>
                ))}
              </ul>
              <p className="mt-1.5 font-medium">{c.fix}</p>
              {canFixTemplate && c.layoutId && c.suggestion ? (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => applyTemplateFix(c.layoutId!)}
                    disabled={busy != null}
                    className="rounded-md bg-rose-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-800 disabled:opacity-50"
                  >
                    {busy === "template" ? "Applying…" : `Add ${c.suggestion.map((t) => `{{${t}}}`).join(" + ")} & re-upload`}
                  </button>
                  {c.stylesUsingLayout > 1 ? (
                    <span className="ml-2 text-[11px] text-rose-700/80">
                      affects {c.stylesUsingLayout - 1} other style(s) using this layout
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}

          {a.missing.length > 0 ? (
            <Detail title={`${a.missing.length} file(s) missing from the folder`} tone="amber">
              {a.missing.map((d) => (
                <li key={d.variantKey}>
                  {d.name} — <code>{d.spName}</code>
                </li>
              ))}
            </Detail>
          ) : null}

          {a.unqueued.length > 0 ? (
            <Detail title={`${a.unqueued.length} approved output(s) were never queued for delivery`} tone="amber">
              {a.unqueued.map((u) => (
                <li key={u.baseKey}>{u.name}</li>
              ))}
            </Detail>
          ) : null}

          {/* Where these files' barcodes came from. */}
          {data!.ean ? <EanLine ean={data!.ean} /> : null}

          {a.stale.length > 0 ? (
            <Detail title={`${a.stale.length} unexpected file(s) in the folder`} tone="zinc">
              {a.stale.map((n) => (
                <li key={n}>
                  <code>{n}</code>
                </li>
              ))}
              <li className="mt-1 list-none text-[11px] text-zinc-500">
                Probably files from an earlier name. Nothing is deleted automatically — remove them in SharePoint if
                they’re outdated.
              </li>
            </Detail>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const EAN_SOURCE: Record<string, { label: string; cls: string }> = {
  po: { label: "PO PDF", cls: "border-emerald-200 bg-emerald-50/60 text-emerald-800" },
  monday: { label: "Monday columns", cls: "border-teal-200 bg-teal-50/60 text-teal-800" },
  none: { label: "not resolved", cls: "border-amber-200 bg-amber-50/60 text-amber-900" },
};

function EanLine({ ean }: { ean: EanSummary }) {
  const meta = EAN_SOURCE[ean.source] ?? EAN_SOURCE.none;
  return (
    <details className={`rounded-md border px-3 py-2 ${meta.cls}`}>
      <summary className="cursor-pointer font-medium">
        Barcodes came from <span className="underline decoration-dotted">{meta.label}</span>
        <span className="ml-1 font-normal opacity-75">· {new Date(ean.at).toLocaleString()}</span>
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]">
        {ean.poOutcome ? <li>PO scrape: {ean.poOutcome}</li> : null}
        <li>Monday: {ean.mondayOutcome}</li>
        {ean.sizesMissingEan.length > 0 ? (
          <li className="font-medium">No EAN-13 for: {ean.sizesMissingEan.join(", ")}</li>
        ) : null}
        {ean.sizesMissingCarton.length > 0 ? (
          <li>No carton EAN for: {ean.sizesMissingCarton.join(", ")}</li>
        ) : null}
      </ul>
      <p className="mt-1 text-[11px] opacity-75">Full detail on the Details tab → Barcodes.</p>
    </details>
  );
}

function Detail({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "amber" | "zinc";
  children: React.ReactNode;
}) {
  return (
    <details
      className={`rounded-md border px-3 py-2 ${
        tone === "amber" ? "border-amber-200 bg-amber-50/50 text-amber-900" : "border-zinc-200 bg-zinc-50 text-zinc-600"
      }`}
    >
      <summary className="cursor-pointer font-medium">{title}</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]">{children}</ul>
    </details>
  );
}
