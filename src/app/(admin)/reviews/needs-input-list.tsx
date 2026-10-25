import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { OutputReadinessNotice, ReadinessPill, type ReadinessHrefs } from "@/components/output-readiness-notice";
import type { NeedsInputStyle } from "@/lib/dashboard/needs-input";
import type { ReadinessRole } from "@/lib/styles/readiness-notice";

// The "Needs input" tab body — one row per style that can't generate yet
// (missing PO / barcodes / Monday fields), folded to what's wrong. Opening a
// row shows the same OutputReadinessNotice the style + review pages render, so
// the "what's missing / who fixes it" ladder and its remedy links (Monday,
// PO→EAN, the style page) are identical. Role-aware: reviewers see field steps
// as theirs to fill.
export function NeedsInputList({
  styles,
  role,
}: {
  styles: NeedsInputStyle[];
  role: ReadinessRole;
}) {
  return (
    <ul className="border-line bg-surface divide-line divide-y overflow-hidden rounded-xl border">
      {styles.map((s) => {
        const hrefs: ReadinessHrefs = {
          openPoEans: "/po-eans",
          review: `/styles/${s.styleId}/review`,
          ...(s.mondayUrl ? { openMonday: s.mondayUrl } : {}),
          ...(s.prodSpecId
            ? {
                openProdSpec: `/prod-specs/${s.prodSpecId}`,
                setBusinessArea: `/prod-specs/${s.prodSpecId}`,
                pinFieldInSpec: `/prod-specs/${s.prodSpecId}`,
              }
            : {}),
          ...(s.sharepointUrl ? { openSuppliersDrive: s.sharepointUrl } : {}),
        };
        return (
          <li key={s.styleId}>
            <details className="group/need">
              <summary className="hover:bg-subtle flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 transition-colors duration-150 [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className="text-faint shrink-0 transition-transform group-open/need:rotate-90"
                />
                <div className="min-w-0 flex-1">
                  <Link href={`/styles/${s.styleId}`} className="text-ink truncate text-[13px] font-medium hover:underline">
                    {s.styleName}
                  </Link>
                  <div className="text-muted truncate text-[12px]">
                    {[s.customerName, s.businessArea, s.poNumber ? `PO ${s.poNumber}` : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {s.total > 0 ? (
                  <span className="text-muted hidden shrink-0 text-[12px] tabular-nums sm:inline">
                    {s.total - s.waiting} of {s.total} ready
                  </span>
                ) : null}
                <ReadinessPill notice={s.notice} className="shrink-0" />
              </summary>
              <div className="border-line bg-bg border-t px-4 py-3 pl-10">
                <OutputReadinessNotice notice={s.notice} role={role} hrefs={hrefs} />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
