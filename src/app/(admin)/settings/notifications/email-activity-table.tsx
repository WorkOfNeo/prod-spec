"use client";

import Link from "next/link";
import { useState } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";

export type EmailActivityRow = {
  id: string;
  type: string;
  status: "SENT" | "SIMULATED" | "SKIPPED" | "FAILED";
  to: string;
  cc: string | null;
  subject: string;
  styleId: string | null;
  whenLabel: string;
};

const STATUS_PILLS: Record<EmailActivityRow["status"], string> = {
  SENT: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SIMULATED: "border-amber-200 bg-amber-50 text-amber-700",
  SKIPPED: "border-zinc-200 bg-zinc-50 text-zinc-500",
  FAILED: "border-red-200 bg-red-50 text-red-700",
};

const TYPE_LABELS: Record<string, string> = {
  REVIEW_READY: "Review ready",
  TICKET_FIXED: "Ticket fixed",
  SUPPLIER_APPROVAL: "Supplier approval",
};

// Activity list for /settings/notifications. The rows are slim (no HTML
// body); "View" opens the shared email dialog which fetches the body from
// /api/admin/email-logs/[id] on demand.
export function EmailActivityTable({ rows }: { rows: EmailActivityRow[] }) {
  const [viewing, setViewing] = useState<EmailOutcomeView | null>(null);

  if (rows.length === 0) {
    return (
      <p className="mt-3 rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-400">
        No emails yet — they appear here as soon as a job finishes generating (sent, simulated or
        skipped).
      </p>
    );
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-[11px] tracking-wide text-zinc-500 uppercase">
            <th className="px-3 py-2 font-semibold">When</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">To</th>
            <th className="px-3 py-2 font-semibold">Subject</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-zinc-100 last:border-b-0">
              <td className="px-3 py-2 whitespace-nowrap text-zinc-500">{row.whenLabel}</td>
              <td className="px-3 py-2 whitespace-nowrap">{TYPE_LABELS[row.type] ?? row.type}</td>
              <td className="px-3 py-2">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_PILLS[row.status]}`}
                >
                  {row.status}
                </span>
              </td>
              <td className="max-w-48 truncate px-3 py-2 text-zinc-600" title={row.to}>
                {row.to || <span className="text-amber-700">—</span>}
              </td>
              <td className="max-w-72 truncate px-3 py-2 text-zinc-600" title={row.subject}>
                {row.subject}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {row.styleId ? (
                  <Link href={`/styles/${row.styleId}`} className="mr-3 text-xs text-zinc-400 underline hover:text-zinc-700">
                    style
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setViewing({
                      status: row.status,
                      type: row.type,
                      to: row.to,
                      cc: row.cc,
                      subject: row.subject,
                      emailLogId: row.id,
                      createdAtLabel: row.whenLabel,
                    })
                  }
                  className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50"
                >
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {viewing ? <EmailSimulationDialog outcome={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
