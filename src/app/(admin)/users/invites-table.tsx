"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  EmailSimulationDialog,
  type EmailOutcomeView,
} from "@/components/email-simulation-dialog";

export type InviteRow = {
  id: string;
  email: string;
  role: "ADMIN" | "REVIEWER";
  status: "PENDING" | "USED" | "REVOKED" | "EXPIRED";
  expiresLabel: string;
  invitedByName: string;
  usedLabel: string | null;
  link: string | null; // only live (pending) invites carry a working link
};

const STATUS_PILLS: Record<InviteRow["status"], { label: string; cls: string }> = {
  PENDING: { label: "Pending", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  USED: { label: "Used", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  REVOKED: { label: "Revoked", cls: "border-zinc-200 bg-zinc-100 text-zinc-600" },
  EXPIRED: { label: "Expired", cls: "border-red-200 bg-red-50 text-red-700" },
};

// Invitations audit + actions. Pending → Copy / Resend / Revoke;
// Expired → Resend (same link, fresh window); Used / Revoked are history.
export function InvitesTable({ invites }: { invites: InviteRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<EmailOutcomeView | null>(null);

  async function copyLink(inv: InviteRow) {
    if (!inv.link) return;
    await navigator.clipboard.writeText(inv.link);
    setCopiedId(inv.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  async function resend(id: string) {
    setError(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/invites/${id}/resend`, { method: "POST" });
    const data = (await res.json().catch(() => null)) as
      | { error?: string; email?: EmailOutcomeView }
      | null;
    setBusyId(null);
    if (!res.ok) {
      setError(data?.error ?? "Could not resend invite");
      return;
    }
    if (data?.email) setOutcome(data.email);
    router.refresh();
  }

  async function revoke(id: string, email: string) {
    if (!window.confirm(`Revoke the invite for ${email}? The link stops working immediately.`)) return;
    setError(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/invites/${id}/revoke`, { method: "POST" });
    setBusyId(null);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Could not revoke invite");
      return;
    }
    router.refresh();
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Expires</th>
            <th className="px-3 py-2">Invited by</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {invites.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-muted">
                No invitations yet. Create one above — you&apos;ll get a link to share.
              </td>
            </tr>
          ) : (
            invites.map((inv) => {
              const pill = STATUS_PILLS[inv.status];
              const busy = busyId === inv.id;
              return (
                <tr key={inv.id} className="border-t border-line">
                  <td data-private className="px-3 py-2">{inv.email}</td>
                  <td className="px-3 py-2 text-muted">{inv.role}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${pill.cls}`}
                    >
                      {pill.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {inv.status === "USED" ? (inv.usedLabel ?? "—") : inv.expiresLabel}
                  </td>
                  <td data-private className="px-3 py-2 text-muted">{inv.invitedByName}</td>
                  <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                    {inv.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          onClick={() => copyLink(inv)}
                          className="text-muted underline hover:text-ink"
                        >
                          {copiedId === inv.id ? "Copied ✓" : "Copy"}
                        </button>
                        <span className="px-1 text-faint">·</span>
                      </>
                    )}
                    {(inv.status === "PENDING" || inv.status === "EXPIRED") && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => resend(inv.id)}
                          className="text-muted underline hover:text-ink disabled:opacity-50"
                        >
                          {busy ? "…" : "Resend"}
                        </button>
                        <span className="px-1 text-faint">·</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => revoke(inv.id, inv.email)}
                          className="text-bad underline hover:text-bad disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                    {inv.status === "USED" && <span className="text-faint">{inv.usedLabel}</span>}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {error && <p className="border-t border-line px-4 py-2 text-xs text-bad">{error}</p>}
      {outcome && <EmailSimulationDialog outcome={outcome} onClose={() => setOutcome(null)} />}
    </div>
  );
}
