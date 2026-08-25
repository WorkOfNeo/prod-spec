"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TrimConcept } from "@/lib/trims/concepts";
import type { TrimRule } from "@/lib/trims/classify";
import type { TrimCensus } from "@/lib/trims/census";

// Four views on one decision — what a trim means.
//
//   Trim values — the vocabulary Monday actually uses, worst-first. The queue.
//   Rules       — the ordered keyword rules that classify BOTH sides. Order is
//                 semantic, and the editor has to make that visible or someone
//                 will "tidy" the list alphabetically and quietly re-label
//                 1,139 styles' colour stickers as carton markings.
//   Layouts     — what each layout answers, for the handful whose name can't be
//                 read.
//   Coverage    — where the buyer's list and ours disagree, in both directions.
//
// Everything is edited locally and saved in one PUT, because a half-applied
// rule set classifies differently from either the old or the new one.

type Tab = "labels" | "rules" | "layouts" | "coverage";

type Props = {
  concepts: TrimConcept[];
  initialRules: TrimRule[];
  initialOverrides: Record<string, string[]>;
  initialLayoutConcepts: Record<string, string>;
};

const SOURCE_STYLES: Record<string, string> = {
  override: "bg-sky-50 text-sky-700 border-sky-200",
  rule: "bg-zinc-50 text-zinc-600 border-zinc-200",
  none: "bg-amber-50 text-amber-800 border-amber-300",
};

function Badge({ children, tone = "rule" }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        SOURCE_STYLES[tone] ?? SOURCE_STYLES.rule
      }`}
    >
      {children}
    </span>
  );
}

export function TrimsEditor({
  concepts,
  initialRules,
  initialOverrides,
  initialLayoutConcepts,
}: Props) {
  const [tab, setTab] = useState<Tab>("labels");
  // Loaded after paint — see the page component for why it isn't server-rendered.
  const [census, setCensus] = useState<TrimCensus | null>(null);
  const [censusState, setCensusState] = useState<"loading" | "ready" | "failed">("loading");
  const [rules, setRules] = useState<TrimRule[]>(initialRules);
  const [overrides, setOverrides] = useState<Record<string, string[]>>(initialOverrides);
  const [layoutConcepts, setLayoutConcepts] =
    useState<Record<string, string>>(initialLayoutConcepts);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyNeedsWork, setOnlyNeedsWork] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/settings/trims")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { census: TrimCensus | null }) => {
        if (cancelled) return;
        setCensus(d.census);
        setCensusState(d.census ? "ready" : "failed");
      })
      .catch(() => {
        if (!cancelled) setCensusState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const conceptLabel = useMemo(
    () => new Map(concepts.map((c) => [c.value, c.label])),
    [concepts],
  );

  const dirty =
    JSON.stringify(rules) !== JSON.stringify(initialRules) ||
    JSON.stringify(overrides) !== JSON.stringify(initialOverrides) ||
    JSON.stringify(layoutConcepts) !== JSON.stringify(initialLayoutConcepts);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/trims", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules, overrides, layoutConcepts }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
      }
      setSaved(true);
      // The census on screen was computed from the OLD configuration, so the
      // counts and badges beside it are now stale. Reload rather than patch
      // them by hand — a half-updated survey is worse than a moment's wait.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [rules, overrides, layoutConcepts]);

  // ---- Trim values -------------------------------------------------------
  const labels = census?.labels ?? [];
  const needsWork = labels.filter((l) => l.source === "none" || l.ambiguous);
  const shownLabels = onlyNeedsWork ? needsWork : labels;

  const setLabelOverride = (normalized: string, value: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === "__auto__") delete next[normalized];
      else if (value === "__none__") next[normalized] = [];
      else next[normalized] = [value];
      return next;
    });
  };

  const labelSelectValue = (normalized: string, concepts: string[], source: string): string => {
    if (source !== "override") return "__auto__";
    if (concepts.length === 0) return "__none__";
    return concepts[0];
  };

  // ---- Layouts -----------------------------------------------------------
  const layouts = census?.layouts ?? [];
  const layoutsNeedingWork = layouts.filter((l) => !l.concept);
  const shownLayouts = onlyNeedsWork ? layoutsNeedingWork : layouts;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200">
        {(
          [
            ["labels", `Trim values${needsWork.length ? ` · ${needsWork.length} to check` : ""}`],
            ["rules", `Rules · ${rules.length}`],
            ["layouts", `Layouts${layoutsNeedingWork.length ? ` · ${layoutsNeedingWork.length} to check` : ""}`],
            ["coverage", "Coverage"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${
              tab === value
                ? "border-zinc-900 text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 pb-2">
          {error && <span className="text-[12px] text-red-600">{error}</span>}
          {saved && !error && <span className="text-[12px] text-emerald-600">Saved</span>}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      {censusState === "loading" && (
        <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[13px] text-zinc-500">
          Reading every style&rsquo;s Trims column…
        </div>
      )}
      {censusState === "failed" && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          The survey of live trim values could not be built, so counts and suggestions are missing.
          The rules below still apply and can still be edited.
        </div>
      )}

      {(tab === "labels" || tab === "layouts") && census && (
        <label className="mt-4 flex items-center gap-2 text-[13px] text-zinc-600">
          <input
            type="checkbox"
            checked={onlyNeedsWork}
            onChange={(e) => setOnlyNeedsWork(e.target.checked)}
          />
          Only show what needs a decision
        </label>
      )}

      {/* ---- Trim values ---- */}
      {tab === "labels" && census && (
        <div className="mt-4">
          <p className="max-w-3xl text-[13px] text-zinc-500">
            {census.totals.distinctLabels} distinct values across{" "}
            {census.totals.stylesWithTrims.toLocaleString()} styles. Anything left on{" "}
            <em>auto</em> follows the rules; setting a value here overrides them permanently. Choose{" "}
            <em>Not packaging</em> to keep a value off the cover entirely — for one-offs like a PO
            number typed into the column.
          </p>
          {shownLabels.length === 0 ? (
            <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
              Nothing needs a decision — every trim value in the book resolves cleanly.
            </p>
          ) : (
            <table className="mt-3 w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-3 font-medium">Monday value</th>
                  <th className="w-20 py-2 pr-3 text-right font-medium">Styles</th>
                  <th className="w-48 py-2 pr-3 font-medium">Resolves to</th>
                  <th className="w-64 py-2 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {shownLabels.map((l) => (
                  <tr key={l.normalized} className="border-b border-zinc-100 align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium text-zinc-800">{l.label}</span>
                      {l.ambiguous && (
                        <span className="ml-2">
                          <Badge tone="none">check</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">{l.styles}</td>
                    <td className="py-2 pr-3">
                      {l.concepts.length === 0 ? (
                        <Badge tone={l.source === "override" ? "override" : "none"}>
                          {l.source === "override" ? "not packaging" : "unmapped"}
                        </Badge>
                      ) : (
                        <span className="text-zinc-700">
                          {l.concepts.map((c) => conceptLabel.get(c) ?? c).join(" + ")}{" "}
                          <Badge tone={l.source}>{l.source}</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <select
                        value={labelSelectValue(l.normalized, l.concepts, l.source)}
                        onChange={(e) => setLabelOverride(l.normalized, e.target.value)}
                        className="w-full rounded border border-zinc-300 px-2 py-1 text-[13px]"
                      >
                        <option value="__auto__">Auto (follow the rules)</option>
                        <option value="__none__">Not packaging — hide it</option>
                        {concepts.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                            {c.artwork ? "" : " (no artwork)"}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---- Rules ---- */}
      {tab === "rules" && (
        <div className="mt-4">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            <strong>Order matters — the first rule that matches wins.</strong> The colour-sticker
            rule sits above the carton-marking rule because &ldquo;Carton marking- Color
            sticker&rdquo; is a colour sticker, and it is on over a thousand styles. Sorting this
            list would silently re-label them.
          </div>
          <div className="mt-3 space-y-2">
            {rules.map((rule, i) => (
              <div
                key={`${rule.concept}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2"
              >
                <span className="w-6 text-right text-[11px] tabular-nums text-zinc-400">{i + 1}</span>
                <select
                  value={rule.concept}
                  onChange={(e) =>
                    setRules((prev) =>
                      prev.map((r, j) => (j === i ? { ...r, concept: e.target.value } : r)),
                    )
                  }
                  className="rounded border border-zinc-300 px-2 py-1 text-[13px]"
                >
                  {concepts.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <input
                  value={rule.keywords.join(", ")}
                  onChange={(e) =>
                    setRules((prev) =>
                      prev.map((r, j) =>
                        j === i
                          ? { ...r, keywords: e.target.value.split(",").map((k) => k.trim()) }
                          : r,
                      ),
                    )
                  }
                  placeholder="keywords, comma separated"
                  className="min-w-[16rem] flex-1 rounded border border-zinc-300 px-2 py-1 font-mono text-[12px]"
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() =>
                      setRules((prev) => {
                        const next = [...prev];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        return next;
                      })
                    }
                    className="rounded border border-zinc-300 px-1.5 py-0.5 text-[12px] text-zinc-600 disabled:opacity-30"
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === rules.length - 1}
                    onClick={() =>
                      setRules((prev) => {
                        const next = [...prev];
                        [next[i], next[i + 1]] = [next[i + 1], next[i]];
                        return next;
                      })
                    }
                    className="rounded border border-zinc-300 px-1.5 py-0.5 text-[12px] text-zinc-600 disabled:opacity-30"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded border border-zinc-300 px-1.5 py-0.5 text-[12px] text-red-600"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setRules((prev) => [...prev, { concept: concepts[0]?.value ?? "", keywords: [] }])
            }
            className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Add rule
          </button>
        </div>
      )}

      {/* ---- Layouts ---- */}
      {tab === "layouts" && census && (
        <div className="mt-4">
          <p className="max-w-3xl text-[13px] text-zinc-500">
            A layout is classified by the last part of its name — &ldquo;Coop DK - Private Label -{" "}
            <strong>Care Label</strong>&rdquo;. Set one explicitly only when that name cannot be
            read, or when the document answers no trim at all.
          </p>
          {shownLayouts.length === 0 ? (
            <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
              Every layout classifies from its name.
            </p>
          ) : (
            <table className="mt-3 w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-3 font-medium">Layout</th>
                  <th className="w-28 py-2 pr-3 font-medium">Status</th>
                  <th className="w-44 py-2 pr-3 font-medium">Answers</th>
                  <th className="w-64 py-2 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {shownLayouts.map((l) => (
                  <tr key={l.variantKey} className="border-b border-zinc-100 align-top">
                    <td className="py-2 pr-3 font-medium text-zinc-800">{l.name}</td>
                    <td className="py-2 pr-3 text-zinc-500">{l.status}</td>
                    <td className="py-2 pr-3">
                      {l.concept ? (
                        <span className="text-zinc-700">
                          {conceptLabel.get(l.concept) ?? l.concept} <Badge tone={l.source}>{l.source}</Badge>
                        </span>
                      ) : (
                        <Badge tone="none">unmapped</Badge>
                      )}
                    </td>
                    <td className="py-2">
                      <select
                        value={
                          Object.prototype.hasOwnProperty.call(layoutConcepts, l.variantKey)
                            ? layoutConcepts[l.variantKey] || "__none__"
                            : "__auto__"
                        }
                        onChange={(e) =>
                          setLayoutConcepts((prev) => {
                            const next = { ...prev };
                            if (e.target.value === "__auto__") delete next[l.variantKey];
                            else if (e.target.value === "__none__") next[l.variantKey] = "";
                            else next[l.variantKey] = e.target.value;
                            return next;
                          })
                        }
                        className="w-full rounded border border-zinc-300 px-2 py-1 text-[13px]"
                      >
                        <option value="__auto__">Auto (from the name)</option>
                        <option value="__none__">Answers no trim</option>
                        {concepts.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---- Coverage ---- */}
      {tab === "coverage" && census && (
        <div className="mt-4 space-y-6">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3">
            <p className="text-[13px] text-zinc-700">
              <strong className="text-zinc-900">
                {census.coverage.stylesWithArtworkGap.toLocaleString()}
              </strong>{" "}
              of {census.coverage.stylesConsidered.toLocaleString()} styles want an artwork trim that
              none of their declared outputs produces. Those lines now appear on the cover as
              supplied separately, rather than not appearing at all.
            </p>
            <p className="mt-2 text-[12px] text-zinc-500">
              Counts ignore per-style output switches and doc-type rules, so treat them as the shape
              of the problem rather than an exact figure. The per-style truth is on the Cover page
              screen&rsquo;s before/after preview.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-[13px] font-semibold text-zinc-800">
                Monday asks, nothing declared answers
              </h3>
              <p className="mt-1 text-[12px] text-zinc-500">
                An <strong>artwork</strong> row here is a candidate for a layout we don&rsquo;t have,
                or an output missing from that ProdSpec.
              </p>
              <table className="mt-2 w-full text-[13px]">
                <tbody>
                  {census.coverage.gapByConcept.slice(0, 14).map((g) => (
                    <tr key={g.concept} className="border-b border-zinc-100">
                      <td className="py-1.5 text-zinc-700">
                        {conceptLabel.get(g.concept) ?? g.concept}
                        {!g.artwork && (
                          <span className="ml-2 text-[11px] text-zinc-400">no artwork</span>
                        )}
                      </td>
                      <td className="w-20 py-1.5 text-right tabular-nums text-zinc-600">
                        {g.styles.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="text-[13px] font-semibold text-zinc-800">
                We deliver it, Monday never mentions it
              </h3>
              <p className="mt-1 text-[12px] text-zinc-500">
                The reverse gap — where the Trims column itself is incomplete. These still print;
                the cover is the union of both lists.
              </p>
              <table className="mt-2 w-full text-[13px]">
                <tbody>
                  {census.coverage.extraByConcept.slice(0, 14).map((g) => (
                    <tr key={g.concept} className="border-b border-zinc-100">
                      <td className="py-1.5 text-zinc-700">
                        {conceptLabel.get(g.concept) ?? g.concept}
                      </td>
                      <td className="w-20 py-1.5 text-right tabular-nums text-zinc-600">
                        {g.styles.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
