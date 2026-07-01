import { OutputReadinessNotice, type ReadinessHrefs } from "@/components/output-readiness-notice";
import type { NeedsInputStyle } from "@/lib/dashboard/needs-input";
import type { ReadinessRole } from "@/lib/styles/readiness-notice";

// The "Needs input" tab body — one readiness card per style that can't generate
// yet (missing PO / barcodes / Monday fields). Reuses the same OutputReadiness
// Notice the style + review pages render, so the "what's missing / who fixes it"
// ladder is identical. Each card links to the remedies (Monday, PO→EAN, the
// style page). Role-aware: reviewers see field steps as theirs to fill.
export function NeedsInputList({
  styles,
  role,
}: {
  styles: NeedsInputStyle[];
  role: ReadinessRole;
}) {
  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
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
          <OutputReadinessNotice
            key={s.styleId}
            notice={s.notice}
            role={role}
            hrefs={hrefs}
            title={s.styleName}
            subtitle={[s.customerName, s.businessArea, s.poNumber].filter(Boolean).join(" · ")}
          />
        );
      })}
    </div>
  );
}
