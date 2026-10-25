import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { Pill, type PillTone } from "@/components/ui/pill";
import type { ApprovedStyleRow } from "@/lib/dashboard/approved-styles";

// The done pile — /reviews "Approved" tab. Read-only list, recent-first, with
// a delivery status per style. Success = "in the supplier's folder", which
// links straight to the folder. The digest "sent" step isn't surfaced.

const DELIVERY: Record<ApprovedStyleRow["delivery"], { label: string; tone: PillTone }> = {
  uploaded: { label: "In the supplier's folder", tone: "good" },
  queued: { label: "Delivery queued", tone: "warn" },
  none: { label: "No delivery", tone: "neutral" },
};

export function ApprovedList({ styles, total }: { styles: ApprovedStyleRow[]; total: number }) {
  return (
    <div>
      {total > styles.length ? (
        <p className="text-muted mb-2 text-[12px]">
          Showing the {styles.length} most recent of {total.toLocaleString()} approved styles.
        </p>
      ) : null}
      <div className="border-line bg-surface overflow-x-auto rounded-xl border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-line text-muted border-b text-left text-[12px]">
              <th className="px-4 py-2 font-medium">Style</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Delivery</th>
              <th className="px-4 py-2 font-medium">Approved</th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {styles.map((s) => {
              const d = DELIVERY[s.delivery];
              return (
                <tr key={s.styleId} className="hover:bg-subtle transition-colors duration-150">
                  <td className="px-4 py-2">
                    <Link href={`/styles/${s.styleId}`} className="text-ink font-medium hover:underline">
                      {s.name}
                    </Link>
                    {s.poNumber ? <div className="text-faint font-mono text-[11px]">{s.poNumber}</div> : null}
                  </td>
                  <td className="text-muted px-4 py-2">
                    {s.customer}
                    {s.businessArea ? <span className="text-faint"> · {s.businessArea}</span> : null}
                  </td>
                  <td className="px-4 py-2">
                    {s.delivery === "uploaded" && s.folderUrl ? (
                      <a
                        href={s.folderUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open the supplier's APPROVED LAYOUTS folder"
                        className="inline-flex hover:opacity-80"
                      >
                        <Pill tone={d.tone} dot>
                          {d.label}
                          <ExternalLink size={11} aria-hidden="true" />
                        </Pill>
                      </a>
                    ) : (
                      <Pill tone={d.tone} dot>
                        {d.label}
                      </Pill>
                    )}
                  </td>
                  <td className="text-muted px-4 py-2 text-[12px] whitespace-nowrap">{formatDate(s.approvedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
