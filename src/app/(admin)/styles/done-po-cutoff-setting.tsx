"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

// Done-group PO cutoff control. Paste a PO ("C-PO63144" or bare digits)
// and save: Done-group styles whose PO parses ABOVE it join the main list.
// Clear the field to hide all Done-group styles again (the default).
// Saving PATCHes the AppSetting and refreshes the server-rendered list.
export function DonePoCutoffSetting({ initialCutoff }: { initialCutoff: number | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initialCutoff !== null ? `C-PO${initialCutoff}` : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(initialCutoff);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/done-po-cutoff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cutoff: value }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; cutoff?: number | null };
      if (!res.ok) throw new Error(j.error ?? `Failed to save (${res.status})`);
      setApplied(j.cutoff ?? null);
      router.refresh(); // re-run the server query with the new cutoff
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Folded to one line under the list header: it's a setting, not part of the
  // list, and most visits never touch it.
  return (
    <details className="group text-[12px]">
      <summary className="text-muted hover:text-ink inline-flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} aria-hidden="true" className="transition-transform group-open:rotate-90" />
        Done-group styles:{" "}
        <span className="text-ink">{applied !== null ? `shown above C-PO${applied}` : "hidden"}</span>
      </summary>
      <div className="border-line bg-surface mt-2 max-w-2xl rounded-xl border p-4">
        <p className="text-muted text-[13px]">
          Done orders are normally hidden here. Paste a PO number to also show Done-group styles whose PO is{" "}
          <em>above</em> it, for example to review a backfill. Clear and save to hide them again.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="C-PO63144"
            aria-label="Show Done-group styles above this PO"
            className="border-line bg-surface text-ink placeholder:text-faint focus:border-accent h-8 w-40 rounded-md border px-3 text-[13px] outline-none"
          />
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {error ? <span className="text-bad">{error}</span> : null}
        </div>
      </div>
    </details>
  );
}
