"use client";

import { useRouter } from "next/navigation";
import { useState, type MouseEvent } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";

// "Rerun" for a SET of outputs on the review screen — the whole style (empty
// variantKeys = classic full re-run: durable approval keeps approved outputs)
// or one doc-type group (explicit variantKeys regenerate everything listed,
// including approved outputs, which then come back for a fresh decision).
// Reviewer-accessible: the rerun endpoint gates on canReview, so reviewers can
// make fresh PDFs after changing the data without waiting for an admin.
//
// The group button renders inside the accordion's <summary>, so the click
// handler must preventDefault — otherwise pressing it would also toggle the
// accordion open/closed.
export function RerunOutputsButton({
  styleId,
  variantKeys,
  label,
  title,
  emphasis = false,
}: {
  styleId: string;
  // Base variantKeys to regenerate; empty = full re-run of the style.
  variantKeys: string[];
  label: string;
  title: string;
  // Top-right style-level button gets the solid look; group buttons stay quiet.
  emphasis?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);

  async function onClick(e: MouseEvent<HTMLButtonElement>) {
    // Inside a <summary>, a plain click would also toggle the accordion.
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKeys }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        emails?: EmailOutcomeView[];
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // Same rule as the per-output Run button: pop the dialog only when the
      // review-ready notification did NOT really go out (simulated/failed).
      const noteworthy = (body.emails ?? []).find((e) => e.status !== "SENT");
      if (noteworthy) setEmail(noteworthy);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error ? <span className="text-xs font-normal text-red-600">{error}</span> : null}
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        title={title}
        className={
          emphasis
            ? "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
            : "rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
        }
      >
        {pending ? "Rerunning…" : `↻ ${label}`}
      </button>
      {email ? <EmailSimulationDialog outcome={email} onClose={() => setEmail(null)} /> : null}
    </span>
  );
}
