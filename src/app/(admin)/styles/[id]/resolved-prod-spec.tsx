"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SupplierLite = { id: string; name: string; country: string | null };

export type ResolvedProdSpecProps = {
  prodSpecId: string;
  name: string;
  businessAreaMondayValue: string;
  businessAreaLabel: string | null;
  autoGenerateThresholdPct: number;
  active: boolean;
  fullyApproved: boolean;
  poNumber: string | null;
  supplierName: string | null;
  // Suppliers attached to the ProdSpec itself (distinct from the style's
  // own linked supplier above).
  suppliers: SupplierLite[];
  // Workflow status of the parent Style — drives the ready/approved badge.
  styleStatus: string;
  // Required-field readiness — the UNION of fields each enabled output needs.
  requiredReadiness: {
    filled: number;
    total: number;
    fields: Array<{ label: string; ok: boolean }>;
  };
  // Pre-run files preview — per enabled output, the PDFs the NEXT run
  // would emit for this style (count + resolved names). Computed with the
  // runner's own StyleData assembly + naming, repeat/split aware, so the
  // operator can verify the output split before generating. `known` false
  // = the stored variant key is no longer in the registry.
  outputsFilesPreview: Array<{ variantKey: string; name: string; known: boolean; files: string[] }>;
};

// Collapsed entry point for the resolved ProdSpec: a compact button showing
// the spec name + readiness at a glance. The full detail (fields, required
// checklist, attached suppliers, Edit link) lives in a popup so it no longer
// dominates the tab. Some styles resolve a heavy spec; this keeps the page
// scannable until you actually want the detail.
export function ResolvedProdSpecButton(props: ResolvedProdSpecProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-sm transition hover:border-line hover:bg-subtle"
      >
        <span className="text-[11px] font-medium text-faint">
          Prod spec
        </span>
        <span className="truncate font-semibold text-ink">{props.name}</span>
        <ReadyBadge
          styleStatus={props.styleStatus}
          filled={props.requiredReadiness.filled}
          total={props.requiredReadiness.total}
        />
        {props.fullyApproved && (
          <span className="inline-flex whitespace-nowrap rounded-full bg-good-soft px-2 py-0.5 text-[11px] font-medium text-good">
            Fully approved
          </span>
        )}
        <span className="whitespace-nowrap text-xs text-faint">View details →</span>
      </button>

      {open && <ResolvedProdSpecModal {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ResolvedProdSpecModal({
  prodSpecId,
  name,
  businessAreaMondayValue,
  businessAreaLabel,
  autoGenerateThresholdPct,
  active,
  poNumber,
  supplierName,
  suppliers,
  styleStatus,
  requiredReadiness,
  outputsFilesPreview,
  onClose,
}: ResolvedProdSpecProps & { onClose: () => void }) {
  const totalFiles = outputsFilesPreview.reduce((sum, o) => sum + o.files.length, 0);
  // Escape to close + lock body scroll while open — matches the picker
  // modal convention elsewhere in the admin.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgb(15_17_21/0.40)] p-4 py-10"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Resolved prod spec"
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-muted">Auto-resolved</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">{name}</span>
              <ReadyBadge
                styleStatus={styleStatus}
                filled={requiredReadiness.filled}
                total={requiredReadiness.total}
              />
            </div>
            <div className="mt-1 text-xs text-muted">
              Business area: <span className="font-mono">{businessAreaMondayValue}</span> · threshold{" "}
              {autoGenerateThresholdPct}% · {active ? "active" : "inactive"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Link
              href={`/prod-specs/${prodSpecId}`}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              Edit prod spec →
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-muted underline hover:text-ink"
            >
              close
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-4 text-xs">
          <Field label="Business area">{businessAreaLabel ?? "—"}</Field>
          <Field label="PO Number">{poNumber ?? "—"}</Field>
          <Field label="Supplier (style)">{supplierName ?? "—"}</Field>
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted">
              Required fields (from selected outputs)
            </div>
            {requiredReadiness.total > 0 && (
              <span
                className={`text-xs font-semibold tabular-nums ${
                  requiredReadiness.filled === requiredReadiness.total
                    ? "text-good"
                    : "text-warn"
                }`}
              >
                {requiredReadiness.filled}/{requiredReadiness.total}
              </span>
            )}
          </div>
          {requiredReadiness.total === 0 ? (
            <p className="mt-2 text-xs text-faint">
              No outputs selected yet — pick outputs on the prod spec to see required fields.
            </p>
          ) : (
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
              {requiredReadiness.fields.map((f, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className={f.ok ? "text-good" : "text-warn"}>
                    {f.ok ? "✓" : "✗"}
                  </span>
                  <span className={f.ok ? "text-ink" : "font-medium text-warn"}>
                    {f.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted">
              Files the next run will generate
            </div>
            {totalFiles > 0 && (
              <span className="text-xs font-semibold tabular-nums text-muted">
                {totalFiles} PDF{totalFiles === 1 ? "" : "s"} total
              </span>
            )}
          </div>
          {outputsFilesPreview.length === 0 ? (
            <p className="mt-2 text-xs text-faint">
              No outputs selected yet — pick outputs on the prod spec to see what a run produces.
            </p>
          ) : (
            <ul className="mt-2 space-y-3">
              {outputsFilesPreview.map((o) => (
                <li key={o.variantKey} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-ink">{o.name}</span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
                        o.known ? "bg-subtle text-ink" : "bg-bad-soft text-bad"
                      }`}
                    >
                      {o.known ? `${o.files.length} PDF${o.files.length === 1 ? "" : "s"}` : "unknown variant"}
                    </span>
                  </div>
                  {o.known && (
                    <ul className="mt-1 space-y-0.5 font-mono text-[11px] leading-relaxed text-muted">
                      {o.files.slice(0, 12).map((f, i) => (
                        <li key={i} className="truncate" title={f}>
                          {f}
                        </li>
                      ))}
                      {o.files.length > 12 && (
                        <li className="font-sans text-faint">+{o.files.length - 12} more</li>
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-faint">
            Counts use the style&apos;s current size/EAN rows — a new PO scrape can change them.
          </p>
        </div>

        <div className="mt-4">
          <div className="text-xs font-medium text-muted">
            Suppliers attached to this ProdSpec
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {suppliers.length === 0 ? (
              <span className="text-xs text-muted">— none —</span>
            ) : (
              suppliers.map((s) => (
                <span
                  key={s.id}
                  className="inline-flex items-center gap-1 rounded-full bg-subtle px-3 py-1 text-xs"
                >
                  <span className="font-medium">{s.name}</span>
                  {s.country && <span className="text-muted">· {s.country}</span>}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Readiness badge for the ProdSpec that will run. Pre-generation it reflects
// required-field completion ("3/5" not-ready → "✓ ready"); once a job runs it
// follows the Style's workflow status (generating → awaiting review →
// approved / rejected).
function ReadyBadge({
  styleStatus,
  filled,
  total,
}: {
  styleStatus: string;
  filled: number;
  total: number;
}) {
  const s = (() => {
    switch (styleStatus) {
      case "APPROVED":
        return { label: "approved", cls: "bg-emerald-100 text-emerald-800", check: true };
      case "REJECTED":
        return { label: "rejected", cls: "bg-red-100 text-red-700", check: false };
      case "AWAITING_REVIEW":
        return { label: "awaiting review", cls: "bg-purple-100 text-purple-800", check: false };
      case "GENERATING":
        return { label: "generating", cls: "bg-blue-100 text-blue-800", check: false };
      default:
        if (total > 0 && filled < total)
          return { label: `${filled}/${total}`, cls: "bg-amber-100 text-amber-800", check: false };
        return { label: "ready", cls: "bg-emerald-100 text-emerald-800", check: true };
    }
  })();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}
    >
      {s.check && <span aria-hidden>✓</span>}
      {s.label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="font-medium">{children}</div>
    </div>
  );
}
