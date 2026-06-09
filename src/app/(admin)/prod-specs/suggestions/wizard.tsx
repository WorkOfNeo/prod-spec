"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type {
  NewBaSuggestion,
  NewProdSpecSuggestion,
} from "@/lib/prod-spec/suggestions";

type Phase = "ba" | "prodspec" | "done";

type Decision = "pending" | "accepted" | "skipped" | "failed";

export function SuggestionsWizard({
  newBusinessAreas,
  newProdSpecs,
}: {
  newBusinessAreas: NewBaSuggestion[];
  newProdSpecs: NewProdSpecSuggestion[];
}) {
  const router = useRouter();

  // We walk Phase 1 (BAs) before Phase 2 (ProdSpecs). If Phase 1 is empty
  // we land directly on Phase 2; same for empty Phase 2 → done.
  const initialPhase: Phase =
    newBusinessAreas.length > 0 ? "ba" : newProdSpecs.length > 0 ? "prodspec" : "done";

  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [baIndex, setBaIndex] = useState(0);
  const [psIndex, setPsIndex] = useState(0);
  const [baDecisions, setBaDecisions] = useState<Decision[]>(() =>
    newBusinessAreas.map(() => "pending"),
  );
  const [psDecisions, setPsDecisions] = useState<Decision[]>(() =>
    newProdSpecs.map(() => "pending"),
  );
  // Pair acceptance can also fail (existing combo, schema mismatch). Track
  // the error text against the specific index so the card surfaces it.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const stats = useMemo(
    () => ({
      baAccepted: baDecisions.filter((d) => d === "accepted").length,
      baSkipped: baDecisions.filter((d) => d === "skipped").length,
      psAccepted: psDecisions.filter((d) => d === "accepted").length,
      psSkipped: psDecisions.filter((d) => d === "skipped").length,
    }),
    [baDecisions, psDecisions],
  );

  function advance(from: Phase) {
    if (from === "ba") {
      if (baIndex + 1 < newBusinessAreas.length) {
        setBaIndex(baIndex + 1);
      } else {
        setPhase(newProdSpecs.length > 0 ? "prodspec" : "done");
      }
    } else if (from === "prodspec") {
      if (psIndex + 1 < newProdSpecs.length) {
        setPsIndex(psIndex + 1);
      } else {
        setPhase("done");
      }
    }
  }

  async function acceptBa() {
    if (busy) return;
    setBusy(true);
    setErrors((e) => ({ ...e, [`ba:${baIndex}`]: "" }));
    const ba = newBusinessAreas[baIndex];
    try {
      const res = await fetch("/api/admin/business-areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mondayValue: ba.mondayValue, name: ba.name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors((e) => ({ ...e, [`ba:${baIndex}`]: body.error ?? `HTTP ${res.status}` }));
        markBa("failed");
        return;
      }
      markBa("accepted");
      advance("ba");
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [`ba:${baIndex}`]: (err as Error).message }));
      markBa("failed");
    } finally {
      setBusy(false);
    }
  }

  function skipBa() {
    if (busy) return;
    markBa("skipped");
    advance("ba");
  }

  async function acceptPs() {
    if (busy) return;
    setBusy(true);
    setErrors((e) => ({ ...e, [`ps:${psIndex}`]: "" }));
    const ps = newProdSpecs[psIndex];
    try {
      const res = await fetch("/api/admin/prod-specs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: ps.customerId, businessAreaId: ps.businessAreaId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors((e) => ({ ...e, [`ps:${psIndex}`]: body.error ?? `HTTP ${res.status}` }));
        markPs("failed");
        return;
      }
      markPs("accepted");
      advance("prodspec");
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [`ps:${psIndex}`]: (err as Error).message }));
      markPs("failed");
    } finally {
      setBusy(false);
    }
  }

  function skipPs() {
    if (busy) return;
    markPs("skipped");
    advance("prodspec");
  }

  function markBa(d: Decision) {
    setBaDecisions((arr) => {
      const next = arr.slice();
      next[baIndex] = d;
      return next;
    });
  }
  function markPs(d: Decision) {
    setPsDecisions((arr) => {
      const next = arr.slice();
      next[psIndex] = d;
      return next;
    });
  }

  if (phase === "done") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center">
        <h2 className="text-lg font-semibold">All caught up</h2>
        <p className="mt-1 text-sm text-zinc-500">
          You stepped through every suggestion. Re-run the wizard after a new sync if more land.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <Summary
            label="Business areas added"
            ok={stats.baAccepted}
            skipped={stats.baSkipped}
            total={newBusinessAreas.length}
          />
          <Summary
            label="Prod specs created"
            ok={stats.psAccepted}
            skipped={stats.psSkipped}
            total={newProdSpecs.length}
          />
        </div>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            href="/prod-specs"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Back to prod specs
          </Link>
          <Link
            href="/prod-specs/suggestions"
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Re-scan
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "ba") {
    const ba = newBusinessAreas[baIndex];
    const err = errors[`ba:${baIndex}`] || "";
    return (
      <WizardShell
        phaseLabel="Business areas"
        position={baIndex + 1}
        total={newBusinessAreas.length}
        nextPhaseLabel={newProdSpecs.length > 0 ? "Prod specs" : undefined}
        nextPhaseCount={newProdSpecs.length}
      >
        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Business area</div>
            <div className="text-xl font-semibold">{ba.name}</div>
            <div className="font-mono text-xs text-zinc-500">
              mondayValue = {ba.mondayValue}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              Items in ghost data
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {ba.totalCount.toLocaleString("en-GB")}
            </div>
            <ul className="mt-1 text-xs text-zinc-500">
              {ba.perBoard.map((b) => (
                <li key={b.mondayBoardId} className="font-mono">
                  {b.boardLabel}: {b.count.toLocaleString("en-GB")}
                </li>
              ))}
            </ul>
          </div>
          {err && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {err}
            </p>
          )}
        </div>

        <Actions
          onSkip={skipBa}
          onAccept={acceptBa}
          acceptLabel="Add business area"
          busy={busy}
        />
      </WizardShell>
    );
  }

  // phase === "prodspec"
  const ps = newProdSpecs[psIndex];
  const err = errors[`ps:${psIndex}`] || "";
  // The score line — we show whichever signal is non-zero, in priority order.
  const evidence =
    ps.matchCount > 0
      ? `${ps.matchCount.toLocaleString("en-GB")} matching style item${ps.matchCount === 1 ? "" : "s"} (customer + BA both match)`
      : ps.customerOnlyCount > 0
        ? `${ps.customerOnlyCount.toLocaleString("en-GB")} item${ps.customerOnlyCount === 1 ? "" : "s"} match this customer (BA not tagged on them yet)`
        : "no direct ghost-data evidence";
  return (
    <WizardShell
      phaseLabel="Prod specs"
      position={psIndex + 1}
      total={newProdSpecs.length}
      previousPhaseLabel="Business areas"
      previousPhaseCount={newBusinessAreas.length}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Customer</div>
            <div className="text-lg font-semibold">{ps.customerName}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Business area</div>
            <div className="text-lg font-semibold">{ps.businessAreaName}</div>
            <div className="font-mono text-xs text-zinc-500">{ps.businessAreaMondayValue}</div>
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Evidence</div>
          <div className="text-sm">{evidence}</div>
          {ps.sampleItems.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-zinc-500">
              {ps.sampleItems.map((s, i) => (
                <li key={i} className="font-mono">
                  · {s}
                </li>
              ))}
            </ul>
          )}
        </div>

        {err && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {err}
          </p>
        )}
      </div>

      <Actions
        onSkip={skipPs}
        onAccept={acceptPs}
        acceptLabel="Create prod spec"
        busy={busy}
      />
    </WizardShell>
  );
}

// =====================================================
// Shell — sticky header (phase / position) + footer (actions). Card body
// is the variable region.
// =====================================================

function WizardShell({
  phaseLabel,
  position,
  total,
  previousPhaseLabel,
  previousPhaseCount,
  nextPhaseLabel,
  nextPhaseCount,
  children,
}: {
  phaseLabel: string;
  position: number;
  total: number;
  previousPhaseLabel?: string;
  previousPhaseCount?: number;
  nextPhaseLabel?: string;
  nextPhaseCount?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-5 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">{phaseLabel}</div>
          <div className="text-sm font-semibold tabular-nums">
            {position} / {total}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          {previousPhaseLabel && (
            <span>
              {previousPhaseLabel}: <span className="tabular-nums">{previousPhaseCount ?? 0}</span> done
            </span>
          )}
          {nextPhaseLabel && (
            <span>
              Next phase: {nextPhaseLabel} ({nextPhaseCount ?? 0})
            </span>
          )}
        </div>
      </header>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

function Actions({
  onSkip,
  onAccept,
  acceptLabel,
  busy,
}: {
  onSkip: () => void;
  onAccept: () => void;
  acceptLabel: string;
  busy: boolean;
}) {
  return (
    <div className="-mx-5 mt-6 -mb-5 flex justify-between gap-2 border-t border-zinc-100 bg-zinc-50 px-5 py-3">
      <button
        type="button"
        onClick={onSkip}
        disabled={busy}
        className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
      >
        Skip
      </button>
      <button
        type="button"
        onClick={onAccept}
        disabled={busy}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {busy ? "Saving…" : acceptLabel}
      </button>
    </div>
  );
}

function Summary({
  label,
  ok,
  skipped,
  total,
}: {
  label: string;
  ok: number;
  skipped: number;
  total: number;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-left">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-medium tabular-nums">
        {ok} added{" "}
        <span className="text-xs font-normal text-zinc-500">
          · {skipped} skipped · {total} reviewed
        </span>
      </div>
    </div>
  );
}
