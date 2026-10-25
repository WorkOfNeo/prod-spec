"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox } from "lucide-react";
import { REQUEST_STATUSES, type OutputStatus, type RequestStatus } from "@/lib/change-requests/types";
import { OutputStatusPill, REQUEST_STATUS_META, RequestStatusPill } from "./status-pill";

// The inbox list: one row per request — R-number, title, each output with its
// status, who filed it, when. The status filter is a query param (?status=),
// so a filtered view is a link that can be shared and reloaded; the page
// re-queries on the server.

export type InboxRow = {
  id: string;
  ref: string;
  title: string;
  status: RequestStatus;
  poNumber: string | null;
  outputs: { id: string; label: string; status: OutputStatus }[];
  requester: string;
  createdLabel: string;
};

export function RequestsInbox({
  rows,
  status,
  showRequester,
}: {
  rows: InboxRow[];
  status: RequestStatus | null;
  showRequester: boolean;
}) {
  const router = useRouter();
  const filters: Array<{ value: RequestStatus | null; label: string }> = [
    { value: null, label: "All" },
    ...REQUEST_STATUSES.map((s) => ({ value: s, label: REQUEST_STATUS_META[s].label })),
  ];
  const columns = showRequester ? 5 : 4;

  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by status">
        {filters.map((f) => {
          const active = f.value === status;
          return (
            <Link
              key={f.value ?? "all"}
              href={f.value ? `/requests?status=${f.value}` : "/requests"}
              role="tab"
              aria-selected={active}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${
                active
                  ? "bg-primary text-white ring-accent"
                  : "bg-surface text-muted ring-line hover:bg-subtle"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <section className="mt-4 overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-subtle text-left text-xs text-muted">
            <tr>
              <th className="w-24 px-4 py-2 font-medium">Request</th>
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-4 py-2 font-medium">Outputs</th>
              {showRequester && <th className="px-4 py-2 font-medium">Requester</th>}
              <th className="w-40 px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns} className="px-4 py-12 text-center">
                  <Inbox className="mx-auto h-6 w-6 text-faint" aria-hidden />
                  <p className="mt-2 text-sm text-muted">
                    {status
                      ? `No requests are ${REQUEST_STATUS_META[status].label.toLowerCase()}.`
                      : "No requests yet."}
                  </p>
                  {!status && (
                    <Link href="/requests/new" className="mt-2 inline-block text-sm font-medium text-ink underline">
                      Report a wrong output
                    </Link>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => router.push(`/requests/${r.id}`)}
                  className="cursor-pointer border-t border-line align-top hover:bg-subtle"
                >
                  <td className="px-3 py-2 font-mono text-xs text-muted">{r.ref}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/requests/${r.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-ink hover:underline"
                    >
                      {r.title}
                    </Link>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <RequestStatusPill status={r.status} />
                      {/* The default title already ends in the PO. */}
                      {r.poNumber && !r.title.includes(r.poNumber) && <span>PO {r.poNumber}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-md flex-wrap gap-1">
                      {r.outputs.map((o) => (
                        <OutputStatusPill key={o.id} label={o.label} status={o.status} />
                      ))}
                    </div>
                  </td>
                  {showRequester && <td className="px-3 py-2 text-muted">{r.requester}</td>}
                  <td className="px-3 py-2 text-muted">{r.createdLabel}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
