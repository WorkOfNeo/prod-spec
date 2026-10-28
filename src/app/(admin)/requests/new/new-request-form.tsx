"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, ImagePlus, Lightbulb, LoaderCircle, Search, Send, Sparkles, X } from "lucide-react";
import { LazyOutputPreview } from "@/components/output-preview";
import { downscaleImage, type PreparedImage } from "@/lib/images/downscale-image";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import type { OrderSearchResult, StyleOutputOption } from "@/lib/change-requests/requests";
import type { SplitResult } from "@/lib/change-requests/agent/split";

// =====================================================
// The request form, top to bottom:
//
//   1. Which order?        search box → POs and styles. A style lists ITS
//                          outputs; "All styles in this PO" lists the PO's
//                          first style's outputs and files the request for the
//                          whole order.
//   2. Which outputs?      cards with a live thumbnail of what prints today
//                          (the style output-preview route; the cover's own
//                          cover-preview); click to pick.
//   3. What should change? one issue per picked output — text plus up to a few
//                          screenshots (picker, drag-drop, or paste from the
//                          clipboard). A pasted email can be split across the
//                          picked outputs first.
//
// Send → POST /api/admin/change-requests → the request page. The server
// re-validates everything; the checks here only keep the button honest.
// =====================================================

type Limits = { maxOutputs: number; maxImagesPerOutput: number; maxImagesTotal: number };

type Scope =
  | {
      kind: "style";
      styleId: string;
      name: string;
      poNumber: string | null;
      customerId: string;
      customerName: string;
    }
  | {
      kind: "po";
      // The PO's first style: its outputs are listed and it is the style the
      // assistant proves the change on.
      styleId: string;
      poNumber: string;
      customerId: string;
      customerName: string;
      styleCount: number;
    };

type IssueState = { text: string; images: PreparedImage[] };
const EMPTY_ISSUE: IssueState = { text: "", images: [] };

const ACCEPTED_TYPES = /^image\/(png|jpeg|webp)$/;
const ACCEPT = "image/png,image/jpeg,image/webp";

const HINTS = [
  "Draw red lines, arrows or boxes where it should look; red marks are read first.",
  "Write the rule, not only the example: 'only for socks', 'only when more than 1 piece'.",
  "Pictures from other styles are fine as examples; their layout is copied, never their data.",
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}

export function NewRequestForm({ limits }: { limits: Limits }) {
  const router = useRouter();

  // 1 — order
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OrderSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);

  // 2 — outputs
  const [outputs, setOutputs] = useState<StyleOutputOption[] | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  // 3 — issues
  const [issues, setIssues] = useState<Record<string, IssueState>>({});
  const [preparing, setPreparing] = useState(0);
  const [email, setEmail] = useState("");
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [splitNote, setSplitNote] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Debounced search while no order is picked.
  useEffect(() => {
    if (scope) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearchError(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const data = await fetchJson<OrderSearchResult>(
          `/api/admin/change-requests/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        );
        setResults(data);
        setSearchError(null);
      } catch (e) {
        if (!ctrl.signal.aborted) setSearchError(e instanceof Error ? e.message : "Search failed");
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [query, scope]);

  // The picked order's outputs.
  const scopeStyleId = scope?.styleId ?? null;
  useEffect(() => {
    if (!scopeStyleId) return;
    let cancelled = false;
    setOutputs(null);
    setOutputsError(null);
    fetchJson<{ outputs: StyleOutputOption[] }>(
      `/api/admin/change-requests/style-outputs?styleId=${encodeURIComponent(scopeStyleId)}`,
    )
      .then((data) => {
        if (!cancelled) setOutputs(data.outputs);
      })
      .catch((e) => {
        if (!cancelled) setOutputsError(e instanceof Error ? e.message : "Could not load the outputs");
      });
    return () => {
      cancelled = true;
    };
  }, [scopeStyleId]);

  function chooseScope(next: Scope) {
    setScope(next);
    setPicked([]);
    setIssues({});
    setSplitNote(null);
    setUnmatched(null);
    setSplitError(null);
  }

  function clearScope() {
    setScope(null);
    setOutputs(null);
    setPicked([]);
    setIssues({});
  }

  function togglePick(variantKey: string) {
    setPicked((prev) => {
      if (prev.includes(variantKey)) return prev.filter((k) => k !== variantKey);
      if (prev.length >= limits.maxOutputs) return prev;
      return [...prev, variantKey];
    });
  }

  // Issues follow the output list's order, not the click order, so the form
  // reads like the style page.
  const pickedOutputs = useMemo(
    () => (outputs ?? []).filter((o) => picked.includes(o.variantKey)),
    [outputs, picked],
  );
  const totalImages = pickedOutputs.reduce((n, o) => n + (issues[o.variantKey]?.images.length ?? 0), 0);

  function setIssueText(key: string, text: string) {
    setIssues((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_ISSUE), text } }));
  }

  // Capped again inside the update, because several images finish preparing
  // at once and each sees the state as it is then.
  function addImage(key: string, image: PreparedImage) {
    setIssues((prev) => {
      const current = prev[key] ?? EMPTY_ISSUE;
      const total = Object.entries(prev)
        .filter(([k]) => picked.includes(k))
        .reduce((n, [, i]) => n + i.images.length, 0);
      if (current.images.length >= limits.maxImagesPerOutput || total >= limits.maxImagesTotal) return prev;
      return { ...prev, [key]: { ...current, images: [...current.images, image] } };
    });
  }

  function removeImage(key: string, index: number) {
    setIssues((prev) => {
      const current = prev[key] ?? EMPTY_ISSUE;
      return { ...prev, [key]: { ...current, images: current.images.filter((_, i) => i !== index) } };
    });
  }

  async function split() {
    setSplitting(true);
    setSplitError(null);
    setSplitNote(null);
    setUnmatched(null);
    try {
      const result = await fetchJson<SplitResult>("/api/admin/change-requests/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: email,
          outputs: pickedOutputs.map((o) => ({ variantKey: o.variantKey, label: o.label })),
        }),
      });
      // Fill empty issues; add to ones the requester already started.
      setIssues((prev) => {
        const next = { ...prev };
        for (const issue of result.issues) {
          if (!issue.variantKey) continue;
          const current = next[issue.variantKey] ?? EMPTY_ISSUE;
          const typed = current.text.trim();
          const text = !typed
            ? issue.text
            : typed.includes(issue.text.trim())
              ? current.text
              : `${current.text.trimEnd()}\n\n${issue.text}`;
          next[issue.variantKey] = { ...current, text };
        }
        return next;
      });
      const leftOver = result.issues
        .filter((i) => !i.variantKey)
        .map((i) => i.text)
        .join("\n\n");
      setUnmatched(leftOver || null);
      const matchedAny = result.issues.some((i) => i.variantKey);
      setSplitNote(result.note ?? (matchedAny ? null : "Nothing in the text matched a picked output."));
    } catch (e) {
      setSplitError(e instanceof Error ? e.message : "Could not split the text");
    } finally {
      setSplitting(false);
    }
  }

  const missingText = pickedOutputs.filter((o) => !(issues[o.variantKey]?.text ?? "").trim());
  const blocker = !scope
    ? "Find the order first."
    : pickedOutputs.length === 0
      ? "Pick at least one output."
      : missingText.length > 0
        ? `Say what should change on ${missingText.map((o) => o.label).join(", ")}.`
        : totalImages > limits.maxImagesTotal
          ? `Up to ${limits.maxImagesTotal} screenshots per request.`
          : preparing > 0
            ? "Preparing screenshots…"
            : null;

  async function send() {
    if (!scope || blocker) return;
    setSending(true);
    setSendError(null);
    try {
      const created = await fetchJson<{ id: string; number: number }>("/api/admin/change-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: email,
          customerId: scope.customerId,
          poNumber: scope.poNumber ?? undefined,
          // No style = the whole PO.
          styleId: scope.kind === "style" ? scope.styleId : undefined,
          outputs: pickedOutputs.map((o) => {
            const issue = issues[o.variantKey] ?? EMPTY_ISSUE;
            return {
              label: o.label,
              variantKey: o.variantKey,
              styleId: scope.styleId,
              text: issue.text,
              attachments: issue.images.map((img) => ({ dataUrl: img.dataUrl, fileName: img.fileName })),
            };
          }),
        }),
      });
      // Stay in the sending state: the next page takes over.
      router.push(`/requests/${created.id}`);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Could not send the request");
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-6">
        {/* 1 — order */}
        <Step number={1} title="Which order?">
          {scope ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-subtle px-3 py-2">
              <div className="min-w-0 text-sm">
                {scope.kind === "style" ? (
                  <>
                    <span className="font-medium text-ink">{scope.name}</span>
                    <span className="text-muted">
                      {scope.poNumber ? ` · ${scope.poNumber}` : ""} · {scope.customerName}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-ink">All styles in {scope.poNumber}</span>
                    <span className="text-muted">
                      {" "}
                      · {scope.customerName} · {scope.styleCount} style{scope.styleCount === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={clearScope}
                disabled={sending}
                className="shrink-0 inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                Change
              </button>
            </div>
          ) : (
            <div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-faint" aria-hidden />
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="PO number, style name or Monday item id"
                  className="w-full rounded-md border border-line py-2 pl-9 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                {searching && (
                  <LoaderCircle className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-faint" aria-hidden />
                )}
              </div>
              {searchError && <p className="mt-2 text-xs text-bad">{searchError}</p>}
              {results && <SearchResults results={results} onPick={chooseScope} />}
            </div>
          )}
        </Step>

        {/* 2 — outputs */}
        {scope && (
          <Step
            number={2}
            title="Which outputs are wrong?"
            aside={
              outputs && outputs.length > 0 ? (
                <span className="text-xs text-muted">
                  {picked.length}/{limits.maxOutputs} picked
                </span>
              ) : null
            }
          >
            {outputsError ? (
              <p className="text-sm text-bad">{outputsError}</p>
            ) : !outputs ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Loading outputs…
              </p>
            ) : outputs.length === 0 ? (
              <p className="text-sm text-muted">
                This style has no outputs configured on its prod spec, so there is nothing to pick.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {outputs.map((o) => {
                  const on = picked.includes(o.variantKey);
                  const full = !on && picked.length >= limits.maxOutputs;
                  return (
                    <OutputCard
                      key={o.variantKey}
                      styleId={scope.styleId}
                      output={o}
                      picked={on}
                      disabled={full || sending}
                      onToggle={() => togglePick(o.variantKey)}
                    />
                  );
                })}
              </div>
            )}
          </Step>
        )}

        {/* 3 — issues */}
        {pickedOutputs.length > 0 && (
          <Step number={3} title="What should change?">
            <div className="rounded-md border border-dashed border-line bg-zinc-50/60 p-3">
              <label htmlFor="cr-email" className="text-xs font-medium text-ink">
                Paste an email
              </label>
              <p className="text-xs text-muted">
                Got the request by email? Paste it here and split it across the picked outputs. You can edit every
                part afterwards. It is kept with the request as written.
              </p>
              <textarea
                id="cr-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                rows={4}
                placeholder="Paste the email text…"
                disabled={sending}
                className="mt-2 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={split}
                  disabled={splitting || sending || !email.trim()}
                  className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {splitting ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Split by output
                </button>
                {splitNote && <span className="text-xs text-warn">{splitNote}</span>}
                {splitError && <span className="text-xs text-bad">{splitError}</span>}
              </div>
              {unmatched && (
                <div className="mt-2 rounded-md border border-transparent bg-warn-soft p-2 text-xs text-warn">
                  <div className="font-medium">Not about a picked output — pick another output or copy it in:</div>
                  <p className="mt-1 whitespace-pre-wrap">{unmatched}</p>
                </div>
              )}
            </div>

            <div className="mt-4 space-y-3">
              {pickedOutputs.map((o) => (
                <IssueCard
                  key={o.variantKey}
                  output={o}
                  issue={issues[o.variantKey] ?? EMPTY_ISSUE}
                  disabled={sending}
                  perOutputMax={limits.maxImagesPerOutput}
                  totalRoom={limits.maxImagesTotal - totalImages}
                  onText={(t) => setIssueText(o.variantKey, t)}
                  onAddImage={(img) => addImage(o.variantKey, img)}
                  onRemoveImage={(i) => removeImage(o.variantKey, i)}
                  onRemove={() => togglePick(o.variantKey)}
                  onPreparing={(delta) => setPreparing((n) => n + delta)}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-faint">
              {totalImages}/{limits.maxImagesTotal} screenshots on this request
            </p>
          </Step>
        )}

        {/* Send */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={send}
              disabled={Boolean(blocker) || sending}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              {sending ? "Sending…" : "Send request"}
            </button>
            {blocker && !sending && <span className="text-xs text-muted">{blocker}</span>}
            {sendError && <span className="text-xs text-bad">{sendError}</span>}
          </div>
          <p className="mt-2 text-xs text-muted">Nothing changes on a print file until an admin approves it.</p>
        </div>
      </div>

      {/* Hints */}
      <aside className="lg:sticky lg:top-8 lg:w-72 lg:shrink-0">
        <div className="rounded-xl border border-line bg-surface p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Lightbulb className="h-4 w-4 text-warn" aria-hidden />
            Get it right first time
          </h2>
          <ul className="mt-3 space-y-3 text-sm text-muted">
            {HINTS.map((h) => (
              <li key={h} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" aria-hidden />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function Step({
  number,
  title,
  aside,
  children,
}: {
  number: number;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-white">
            {number}
          </span>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SearchResults({ results, onPick }: { results: OrderSearchResult; onPick: (scope: Scope) => void }) {
  if (results.pos.length === 0 && results.styles.length === 0) {
    return <p className="mt-3 text-sm text-muted">No active order or style matches.</p>;
  }
  return (
    <div className="mt-3 space-y-4">
      {results.pos.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted">Purchase orders</div>
          <ul className="mt-1 divide-y divide-line rounded-md border border-line">
            {results.pos.map((po) => (
              <li
                key={`${po.poNumber}-${po.customerId}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium text-ink">{po.poNumber}</span>
                  <span className="text-muted">
                    {" "}
                    · {po.customerName} · {po.styleCount} style{po.styleCount === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!po.firstStyleId}
                  onClick={() =>
                    po.firstStyleId &&
                    onPick({
                      kind: "po",
                      styleId: po.firstStyleId,
                      poNumber: po.poNumber,
                      customerId: po.customerId,
                      customerName: po.customerName,
                      styleCount: po.styleCount,
                    })
                  }
                  className="shrink-0 inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  All styles in this PO
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {results.styles.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted">Styles</div>
          <ul className="mt-1 divide-y divide-line rounded-md border border-line">
            {results.styles.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() =>
                    onPick({
                      kind: "style",
                      styleId: s.id,
                      name: s.name,
                      poNumber: s.poNumber,
                      customerId: s.customerId,
                      customerName: s.customerName,
                    })
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-subtle"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-ink">{s.name}</span>
                    <span className="text-muted">
                      {s.poNumber ? ` · ${s.poNumber}` : ""} · {s.customerName}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">#{s.mondayItemId}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Thumbnail box height in px; the preview is narrowed so the label's full
// height fits, keeping its proportions.
const THUMB_PX = 144;

function OutputCard({
  styleId,
  output,
  picked,
  disabled,
  onToggle,
}: {
  styleId: string;
  output: StyleOutputOption;
  picked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ratio = output.heightMm > 0 ? output.widthMm / output.heightMm : 1;
  const src =
    output.variantKey === COVER_VARIANT_KEY
      ? `/api/admin/styles/${encodeURIComponent(styleId)}/cover-preview`
      : `/api/admin/styles/${encodeURIComponent(styleId)}/output-preview?variantKey=${encodeURIComponent(output.variantKey)}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={picked}
      className={`group relative flex flex-col overflow-hidden rounded-lg border bg-surface text-left transition ${
        picked ? "border-ink ring-2 ring-accent" : "border-line hover:border-zinc-400"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <div className="flex items-start justify-center overflow-hidden bg-zinc-100/70 p-2" style={{ height: THUMB_PX + 16 }}>
        <div className="pointer-events-none w-full" style={{ maxWidth: Math.max(48, Math.round(THUMB_PX * ratio)) }}>
          <LazyOutputPreview src={src} widthMm={output.widthMm} heightMm={output.heightMm} />
        </div>
      </div>
      <div className="flex items-start justify-between gap-2 border-t border-line px-2.5 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-ink" title={output.label}>
            {output.label}
          </div>
          <div className="text-[11px] text-muted">
            {Math.round(output.widthMm)}×{Math.round(output.heightMm)} mm
          </div>
        </div>
        <span
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
            picked ? "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" : "border-line bg-surface"
          }`}
          aria-hidden
        >
          {picked && <Check className="h-3 w-3" />}
        </span>
      </div>
    </button>
  );
}

function IssueCard({
  output,
  issue,
  disabled,
  perOutputMax,
  totalRoom,
  onText,
  onAddImage,
  onRemoveImage,
  onRemove,
  onPreparing,
}: {
  output: StyleOutputOption;
  issue: IssueState;
  disabled: boolean;
  perOutputMax: number;
  totalRoom: number;
  onText: (text: string) => void;
  onAddImage: (image: PreparedImage) => void;
  onRemoveImage: (index: number) => void;
  onRemove: () => void;
  onPreparing: (delta: number) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const room = Math.max(0, Math.min(perOutputMax - issue.images.length, totalRoom));
  const full = room === 0;

  // One path for the picker, drag-drop and clipboard paste.
  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setFileError(null);
    const accepted = files.filter((f) => ACCEPTED_TYPES.test(f.type));
    if (accepted.length === 0) {
      setFileError("Only PNG, JPEG or WebP images can be attached.");
      return;
    }
    if (room <= 0) {
      setFileError(
        issue.images.length >= perOutputMax
          ? `Up to ${perOutputMax} screenshots per output.`
          : "This request has as many screenshots as it can take.",
      );
      return;
    }
    const take = accepted.slice(0, room);
    if (accepted.length > room) setFileError(`Added the first ${room}.`);
    setBusy((n) => n + take.length);
    onPreparing(take.length);
    for (const file of take) {
      try {
        onAddImage(await downscaleImage(file));
      } catch {
        setFileError("Couldn't read one of those images — try a PNG or JPEG.");
      } finally {
        setBusy((n) => n - 1);
        onPreparing(-1);
      }
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // the same file can be picked again after a remove
    void addFiles(files);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  // A screenshot pasted from the clipboard (Cmd/Ctrl+V anywhere on the card).
  // Text pastes go through untouched.
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
    void addFiles(images);
  }

  return (
    <div
      onPaste={onPaste}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled && !dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
      className={`rounded-lg border bg-surface p-3 transition ${
        dragOver ? "border-transparent ring-2 ring-red-300" : "border-line"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm font-medium text-ink">{output.label}</div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          title="Remove this output"
          aria-label={`Remove ${output.label}`}
          className="rounded p-1 text-faint hover:bg-subtle hover:text-ink disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <textarea
        value={issue.text}
        onChange={(e) => onText(e.target.value)}
        disabled={disabled}
        rows={4}
        placeholder="What is wrong, and how should it look? Write the rule, not only the example."
        className="mt-2 w-full resize-y rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {issue.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {issue.images.map((img, i) => (
            <div
              key={`${img.fileName}-${i}`}
              className="relative h-16 w-16 overflow-hidden rounded-md border border-line bg-subtle"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
              <img src={img.dataUrl} alt={img.fileName} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemoveImage(i)}
                disabled={disabled}
                aria-label={`Remove ${img.fileName}`}
                className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[rgb(15_17_21/0.60)] text-white hover:bg-[rgb(15_17_21/0.80)] disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label
          className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50 ${
            disabled || full ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-subtle"
          }`}
        >
          <input type="file" accept={ACCEPT} multiple className="hidden" onChange={onPick} disabled={disabled || full} />
          <ImagePlus className="h-3.5 w-3.5" aria-hidden />
          Add screenshot{issue.images.length > 0 ? `s · ${issue.images.length}/${perOutputMax}` : ""}
        </label>
        <span className="text-xs text-faint">
          {busy > 0 ? "Preparing…" : dragOver ? "Drop to attach" : full ? "" : "or drag & drop, or paste"}
        </span>
      </div>
      {fileError && <p className="mt-1 text-xs text-warn">{fileError}</p>}
    </div>
  );
}
