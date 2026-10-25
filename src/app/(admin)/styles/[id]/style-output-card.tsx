"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LazyOutputPreview } from "@/components/output-preview";
import { OutputThumbnail } from "./output-thumbnail";
import { RunOutputButton } from "./run-output-button";
import { CartonPrintsButton } from "./carton-prints-dialog";
import type { AssetReviewStatus } from "@/generated/prisma/enums";

export type InfoAreaSizeOption = {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
};

// mm values accept a comma OR dot decimal ("27,5" → 27.5); display shows a
// comma back. Info-area sizes can be fractional (e.g. 27.5 mm).
function parseMm(raw: string): number {
  return Number(String(raw).replace(",", ".").trim());
}
function fmtMm(n: number): string {
  return String(n).replace(".", ",");
}

// One output of one style, as a fold-out row. Collapsed it shows just the
// ready dot + name + a missing-fields hint, with the per-output Run button
// alongside, so a style with many outputs stays scannable. Folded out it
// reveals the LIVE preview rendered from the style's current data (same
// assembly as the real render — see /api/admin/styles/[id]/output-preview),
// the missing-field / pin / data-note chips, and the LAST GENERATED artifact.
// The live preview only fetches once the row is open, so the page doesn't
// render every output up front.
export type StyleOutputCardProps = {
  styleId: string;
  // ADMIN-only: the per-output Run + carton-print buttons are generation
  // actions (the API is ADMIN-gated), so REVIEWERs see the card without them.
  isAdmin: boolean;
  variantKey: string;
  name: string;
  ready: boolean;
  missing: string[];
  // A doc-type keyword rule skips this output for this style — won't generate.
  excluded?: boolean;
  exclusionReason?: string | null;
  widthMm: number;
  heightMm: number;
  // Pinned fields on this output ("Customer name = Netto A/S").
  pins: Array<{ label: string; value: string }>;
  // Data notes, e.g. "No delivery term on row — defaulting to DDP".
  notes: string[];
  thumbSrc: string | null;
  pdfHref: string | null;
  generatedAt: string | null;
  // Two INDEPENDENT manual-carton capabilities. Either one shows the badge
  // + the "Customize" action alongside Run:
  //   • cartonNumbering — numbered X-of-Y sets ({{cartonNo}}/{{cartonTotal}}).
  //   • multipleStyles  — Custom Carton Marking: other same-PO styles on the
  //     box via {{style2}}… (a manual one-off; standard output stays single).
  cartonNumbering: boolean;
  // Per-PDF review state of the latest generated asset for this output, or
  // null when nothing has been generated yet. Surfaces the approved state
  // (mirrors the review screen) directly on the Outputs list.
  reviewStatus: AssetReviewStatus | null;
  multipleStyles: boolean;
  // Info-area sizing: when isInfoArea, the output's print size is switchable
  // here (admin size or one-time custom). The pick is stored on the
  // ProdSpec output, so prodSpecId is needed to PATCH it.
  isInfoArea: boolean;
  prodSpecId: string | null;
  infoAreaSizeId: string | null;
  // Resolved name of the current pick (resolved server-side against ALL
  // sizes, so a deactivated pick still reads its name). null = custom.
  infoAreaSizeName: string | null;
  // Active admin sizes offered in the dropdown.
  infoAreaSizes: InfoAreaSizeOption[];
};

export function StyleOutputCard(p: StyleOutputCardProps) {
  const [open, setOpen] = useState(false);
  const hasChips =
    p.missing.length > 0 ||
    p.pins.length > 0 ||
    p.notes.length > 0 ||
    Boolean(p.excluded && p.exclusionReason);
  const showSizeControl = p.isInfoArea && p.prodSpecId !== null;
  // A label for the header dims readout: "<size name> · W × H mm".
  const sizeLabel = p.isInfoArea ? (p.infoAreaSizeName ?? "Custom") : null;
  // Re-fetch the live preview whenever the resolved size changes.
  const previewKey = `${p.infoAreaSizeId ?? "custom"}-${p.widthMm}x${p.heightMm}`;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      {/* Header — the toggle and the Run button are siblings (not nested
          buttons), so running an output never toggles the row. */}
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronIcon open={open} />
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
              p.excluded ? "bg-amber-400" : p.ready ? "bg-good" : "bg-zinc-300"
            }`}
          />
          <span className="truncate text-sm font-semibold text-ink" title={p.name}>
            {p.name}
          </span>
          {p.excluded && (
            <span
              title={p.exclusionReason ?? "Skipped by a document-type keyword rule"}
              className="shrink-0 rounded-full border border-transparent bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn"
            >
              Excluded
            </span>
          )}
          {p.reviewStatus === "APPROVED" && (
            <span
              title="This output was approved in review"
              className="shrink-0 rounded-full border border-transparent bg-good-soft px-2 py-0.5 text-[11px] font-semibold text-good"
            >
              ✓ Approved
            </span>
          )}
          {p.reviewStatus === "REJECTED" && (
            <span
              title="This output was rejected in review"
              className="shrink-0 rounded-full border border-transparent bg-bad-soft px-2 py-0.5 text-[11px] font-semibold text-bad"
            >
              ✗ Rejected
            </span>
          )}
          {/* Two INDEPENDENT carton capabilities — distinct chips so the
              overview tells them apart at a glance. */}
          {p.cartonNumbering && (
            <span
              title="Carton numbering — print a numbered set (X of Y) from the Customize action"
              className="shrink-0 rounded border border-transparent bg-warn-soft px-1.5 py-0.5 text-[11px] font-bold text-warn"
            >
              X of Y
            </span>
          )}
          {p.multipleStyles && (
            <span
              title="Multiple styles — place other styles from the same PO on the box ({{style2}}…), a manual one-off"
              className="shrink-0 rounded border border-transparent bg-accent-soft px-1.5 py-0.5 text-[11px] font-bold text-accent-text"
            >
              Multi-style
            </span>
          )}
          {!open && p.missing.length > 0 && (
            <span className="shrink-0 rounded-full border border-transparent bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn">
              {p.missing.length} missing
            </span>
          )}
        </button>
        <span className="hidden flex-shrink-0 text-[11px] tabular-nums text-faint sm:inline">
          {sizeLabel ? `${sizeLabel} · ` : ""}
          {fmtMm(p.widthMm)} × {fmtMm(p.heightMm)} mm
        </span>
        {p.excluded ? (
          // Skipped by a doc-type rule — running it would generate nothing, so
          // offer no Run/Carton actions (for anyone), just a muted note (reason
          // is on the badge + in the chips below).
          <span className="flex-shrink-0 text-[11px] font-medium text-warn">Won’t generate</span>
        ) : p.isAdmin ? (
          // ADMIN-only generation actions (the API is ADMIN-gated) — REVIEWERs
          // see the card without Run/Carton.
          <>
            {(p.cartonNumbering || p.multipleStyles) && (
              <CartonPrintsButton
                styleId={p.styleId}
                variantKey={p.variantKey}
                name={p.name}
                ready={p.ready}
                widthMm={p.widthMm}
                heightMm={p.heightMm}
                cartonNumbering={p.cartonNumbering}
                multipleStyles={p.multipleStyles}
              />
            )}
            <RunOutputButton
              styleId={p.styleId}
              variantKey={p.variantKey}
              ready={p.ready}
              missingLabels={p.missing}
            />
          </>
        ) : null}
      </div>

      {open && (
        <div className="border-t border-line">
          {hasChips && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {p.excluded && p.exclusionReason ? (
                <span className="rounded-full border border-transparent bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn">
                  {p.exclusionReason}
                </span>
              ) : null}
              {p.missing.map((label) => (
                <span
                  key={`m-${label}`}
                  className="rounded-full border border-transparent bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn"
                >
                  missing: {label}
                </span>
              ))}
              {p.pins.map((pin) => (
                <span
                  key={`p-${pin.label}`}
                  title={`Pinned in the ProdSpec editor — always "${pin.value}"`}
                  className="rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink"
                >
                  📌 {pin.label} = {pin.value}
                </span>
              ))}
              {p.notes.map((note) => (
                <span
                  key={`n-${note}`}
                  className="rounded-full border border-transparent bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text"
                >
                  {note}
                </span>
              ))}
            </div>
          )}

          {showSizeControl && (
            <div className="border-b border-line px-4 py-3">
              <InfoAreaSizeControl
                prodSpecId={p.prodSpecId!}
                variantKey={p.variantKey}
                sizes={p.infoAreaSizes}
                currentSizeId={p.infoAreaSizeId}
                currentSizeName={p.infoAreaSizeName}
                widthMm={p.widthMm}
                heightMm={p.heightMm}
              />
            </div>
          )}

          <div className="bg-subtle p-4">
            <div className="mb-1.5 text-[11px] font-medium text-faint">
              Live preview · current data
            </div>
            <LazyOutputPreview
              src={`/api/admin/styles/${p.styleId}/output-preview?variantKey=${encodeURIComponent(p.variantKey)}`}
              widthMm={p.widthMm}
              heightMm={p.heightMm}
              refreshKey={previewKey}
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <OutputThumbnail
                thumbSrc={p.thumbSrc}
                href={p.pdfHref}
                name={p.name}
                generatedAt={p.generatedAt}
              />
              <div className="min-w-0 text-[11px] leading-tight text-muted">
                <div className="font-medium text-faint">Last generated</div>
                <div className="truncate">{p.generatedAt ?? "never"}</div>
              </div>
            </div>
            <span className="flex-shrink-0 text-[11px] tabular-nums text-faint">
              {fmtMm(p.widthMm)} × {fmtMm(p.heightMm)} mm
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Per-style size switcher for an info-area output. A dropdown of the admin
// sizes plus "Custom…"; picking an admin size saves immediately, "Custom"
// reveals width/height inputs for a one-time size. The pick persists on the
// ProdSpec output (shared by every style under the spec) and a router
// refresh re-renders the card + live preview at the new dimensions.
function InfoAreaSizeControl({
  prodSpecId,
  variantKey,
  sizes,
  currentSizeId,
  currentSizeName,
  widthMm,
  heightMm,
}: {
  prodSpecId: string;
  variantKey: string;
  sizes: InfoAreaSizeOption[];
  currentSizeId: string | null;
  currentSizeName: string | null;
  widthMm: number;
  heightMm: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Local "editing a custom size" flag — true while the user is on the
  // Custom option before saving. Derived default: custom when no admin pick.
  const [pendingCustom, setPendingCustom] = useState(currentSizeId === null);
  const [customW, setCustomW] = useState(fmtMm(widthMm));
  const [customH, setCustomH] = useState(fmtMm(heightMm));

  const showCustom = pendingCustom || currentSizeId === null;
  const selectValue = showCustom ? "custom" : `size:${currentSizeId}`;
  // The current pick may reference a now-deactivated size (absent from the
  // active list) — keep it selectable with a labelled synthetic option.
  const currentMissing =
    currentSizeId !== null && !sizes.some((s) => s.id === currentSizeId);

  async function patch(body: {
    infoAreaSizeId: string | null;
    widthMm?: number;
    heightMm?: number;
  }) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/prod-specs/${prodSpecId}/output-info-area-size`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKey, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function onSelect(value: string) {
    if (value === "custom") {
      setPendingCustom(true);
      setCustomW(fmtMm(widthMm));
      setCustomH(fmtMm(heightMm));
      return;
    }
    setPendingCustom(false);
    void patch({ infoAreaSizeId: value.slice("size:".length) });
  }

  const cw = parseMm(customW);
  const ch = parseMm(customH);
  const customValid =
    Number.isFinite(cw) && cw > 0 && cw <= 1000 && Number.isFinite(ch) && ch > 0 && ch <= 1000;
  const customDirty = cw !== widthMm || ch !== heightMm;

  return (
    <div>
      <div className="text-[11px] font-medium text-faint">
        Info area size
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select
          value={selectValue}
          disabled={busy}
          onChange={(e) => onSelect(e.target.value)}
          className="h-8 rounded-md border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50"
        >
          {sizes.map((s) => (
            <option key={s.id} value={`size:${s.id}`}>
              {s.name} · {fmtMm(s.widthMm)} × {fmtMm(s.heightMm)} mm
            </option>
          ))}
          {currentMissing && (
            <option value={`size:${currentSizeId}`}>
              {(currentSizeName ?? "Selected size") + " (disabled)"}
            </option>
          )}
          <option value="custom">Custom…</option>
        </select>

        {showCustom && (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="decimal"
              value={customW}
              disabled={busy}
              onChange={(e) => setCustomW(e.target.value)}
              className="w-16 rounded-md border border-line px-2 py-1.5 text-sm tabular-nums"
              aria-label="Custom width (mm)"
            />
            <span className="text-xs text-faint">×</span>
            <input
              type="text"
              inputMode="decimal"
              value={customH}
              disabled={busy}
              onChange={(e) => setCustomH(e.target.value)}
              className="w-16 rounded-md border border-line px-2 py-1.5 text-sm tabular-nums"
              aria-label="Custom height (mm)"
            />
            <span className="text-xs text-faint">mm</span>
            <button
              type="button"
              disabled={busy || !customValid || (!customDirty && currentSizeId === null)}
              onClick={() => void patch({ infoAreaSizeId: null, widthMm: cw, heightMm: ch })}
              className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Apply"}
            </button>
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-muted">
        Sets the printed size for this info-area output. Applies wherever this Prod Spec prints it.
      </p>
      {err && <p className="mt-1 text-[11px] text-bad">{err}</p>}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
