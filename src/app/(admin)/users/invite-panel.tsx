"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  EmailSimulationDialog,
  type EmailOutcomeView,
} from "@/components/email-simulation-dialog";

type CreatedInvite = { id: string; email: string; link: string };

// "Invite someone": email + role → Create invite → a result box with the
// single-use link. Copy link works immediately; Send email goes through
// the flag-aware dispatcher (simulated while RESEND_EMAILS is off — the
// dialog shows exactly what WOULD have been sent).
export function InvitePanel({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("REVIEWER");
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [outcome, setOutcome] = useState<EmailOutcomeView | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setPending(true);
    const res = await fetch("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const data = (await res.json().catch(() => null)) as
      | { error?: string; invite?: { id: string; email: string }; link?: string }
      | null;
    setPending(false);
    if (!res.ok || !data?.invite || !data.link) {
      setError(data?.error ?? "Could not create invite");
      return;
    }
    setCreated({ id: data.invite.id, email: data.invite.email, link: data.link });
    setEmail("");
    router.refresh();
  }

  async function copyLink() {
    if (!created) return;
    await navigator.clipboard.writeText(created.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // The freshly created invite is re-sent through the resend endpoint —
  // same link, fresh 7-day window (a no-op seconds after creation).
  async function sendEmail() {
    if (!created) return;
    setError(null);
    setSending(true);
    const res = await fetch(`/api/admin/invites/${created.id}/resend`, { method: "POST" });
    const data = (await res.json().catch(() => null)) as
      | { error?: string; email?: EmailOutcomeView }
      | null;
    setSending(false);
    if (!res.ok) {
      setError(data?.error ?? "Could not send the email");
      return;
    }
    if (data?.email) setOutcome(data.email);
    router.refresh();
  }

  return (
    <div>
      <form onSubmit={onCreate} className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          required
          placeholder="name@company.com"
          value={email}
          disabled={disabled || pending}
          onChange={(e) => setEmail(e.target.value)}
          className="w-64 rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        />
        <select
          value={role}
          disabled={disabled || pending}
          onChange={(e) => setRole(e.target.value)}
          className="h-7 rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent disabled:opacity-50"
        >
          <option value="REVIEWER">REVIEWER</option>
          <option value="ADMIN">ADMIN</option>
        </select>
        <button
          type="submit"
          disabled={disabled || pending}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create invite"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}

      {created && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-transparent bg-good-soft px-3 py-2">
          <span data-private className="text-xs font-semibold text-good">
            Invite for {created.email} ready →
          </span>
          <code className="min-w-0 flex-1 truncate rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-muted">
            {created.link}
          </code>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={sendEmail}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send email"}
          </button>
        </div>
      )}

      {outcome && <EmailSimulationDialog outcome={outcome} onClose={() => setOutcome(null)} />}
    </div>
  );
}
