"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";

export function RerunButton({
  styleId,
  disabled,
  // Caption depends on whether the style has generated outputs yet: "Generate"
  // for a first run, "Re-run" once outputs exist. Both hit the same endpoint.
  label = "Re-run",
  pendingLabel = "Re-running…",
}: {
  styleId: string;
  disabled?: boolean;
  label?: string;
  pendingLabel?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);

  async function onClick() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/rerun`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        emails?: EmailOutcomeView[];
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // While RESEND_EMAILS is off the review-ready notification comes back
      // SIMULATED — show it. Really-sent emails don't need a takeover.
      const noteworthy = (body.emails ?? []).find((e) => e.status !== "SENT");
      if (noteworthy) setEmail(noteworthy);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
      >
        {pending ? pendingLabel : label}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
      {email ? <EmailSimulationDialog outcome={email} onClose={() => setEmail(null)} /> : null}
    </div>
  );
}
