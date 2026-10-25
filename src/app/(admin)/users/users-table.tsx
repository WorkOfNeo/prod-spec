"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  EmailSimulationDialog,
  type EmailOutcomeView,
} from "@/components/email-simulation-dialog";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "REVIEWER";
  joinedLabel: string;
};

// People panel: inline role switch, send-reset-link and remove. The server
// enforces the last-admin guard and blocks self-removal; this UI mirrors
// those rules (no Remove on your own row) and surfaces server errors inline.
export function UsersTable({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<EmailOutcomeView | null>(null);
  const [resetLink, setResetLink] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function setRole(id: string, role: string) {
    setError(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setBusyId(null);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Could not change role");
      return;
    }
    router.refresh();
  }

  // Sends the user a single-use link to set their own password. We never
  // set it for them — the link is also surfaced below for copy-paste, for
  // when the email can't reach them (or RESEND_EMAILS is off).
  async function sendReset(id: string, email: string) {
    if (!window.confirm(`Email ${email} a link to set a new password?`)) return;
    setError(null);
    setResetLink(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}/send-reset`, { method: "POST" });
    const data = (await res.json().catch(() => null)) as
      | { error?: string; link?: string; email?: EmailOutcomeView }
      | null;
    setBusyId(null);
    if (!res.ok) {
      setError(data?.error ?? "Could not send the reset link");
      return;
    }
    if (data?.link) setResetLink({ email, link: data.link });
    if (data?.email) setOutcome(data.email);
  }

  async function copyLink() {
    if (!resetLink) return;
    await navigator.clipboard.writeText(resetLink.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function remove(id: string, email: string) {
    if (!window.confirm(`Remove ${email}? They will be signed out and can no longer log in.`)) return;
    setError(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    setBusyId(null);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Could not remove user");
      return;
    }
    router.refresh();
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Joined</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-line">
              <td data-private className="px-3 py-2">{u.name}</td>
              <td data-private className="px-3 py-2 text-muted">{u.email}</td>
              <td className="px-3 py-2">
                <select
                  value={u.role}
                  disabled={busyId === u.id}
                  onChange={(e) => setRole(u.id, e.target.value)}
                  className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="REVIEWER">REVIEWER</option>
                </select>
              </td>
              <td className="px-3 py-2 text-muted">{u.joinedLabel}</td>
              <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => sendReset(u.id, u.email)}
                    className="text-xs text-muted underline hover:text-ink disabled:opacity-50"
                  >
                    Send reset link
                  </button>
                  {u.id === currentUserId ? (
                    <span className="text-xs text-faint">you</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === u.id}
                      onClick={() => remove(u.id, u.email)}
                      className="text-xs text-bad underline hover:text-bad disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="border-t border-line px-4 py-2 text-xs text-bad">{error}</p>}

      {resetLink && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-good-soft px-4 py-2">
          <span data-private className="text-xs font-semibold text-good">
            Reset link for {resetLink.email} →
          </span>
          <code className="min-w-0 flex-1 truncate rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-muted">
            {resetLink.link}
          </code>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
        </div>
      )}

      {outcome && <EmailSimulationDialog outcome={outcome} onClose={() => setOutcome(null)} />}
    </div>
  );
}
