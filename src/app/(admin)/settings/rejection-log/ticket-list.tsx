"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Image as ImageIcon, MessageSquare, RefreshCw, Search, Sparkles } from "lucide-react";
import { outputTypeLabel } from "./rejection-filters";
import { FacetFilter, type FacetOption } from "@/components/facet-filter";
import { AiFixDialog } from "./ai-fix-dialog";
import { Button, buttonClass } from "@/components/ui/button";
import { Pill, type PillTone } from "@/components/ui/pill";
import { UserAvatar } from "@/components/user-avatar";
import { splitTicketComment } from "@/lib/tickets/thread";

// The rejection log's workbench, as a split view: every reviewer comment on
// the left, grouped by style; the selected one on the right with the PDF the
// reviewer saw, the conversation, and what to do about it. Bulk selection
// (checkboxes, "Select by comment") drives the floating bar at the bottom.

// A rendered PDF for a ticket's output (jobId + the preview query that
// addresses it), with its review state.
export type AssetView = {
  jobId: string;
  previewQuery: string;
  placeholderCount: number;
  reviewStatus: string;
  jobStatus: string;
  generatedAtLabel: string;
};

// Loaded on demand from /api/admin/rejection-tickets/[id]/assets when a ticket
// is selected: the originally-rejected PDF plus the latest one for the output.
export type TicketAssets = {
  rejected: AssetView | null;
  latest: AssetView | null;
};

export type TicketRow = {
  id: string;
  status: "OPEN" | "IN_PROGRESS" | "FIXED" | "RESOLVED";
  styleId: string;
  styleName: string;
  styleNumber: string;
  outputName: string;
  // docType (e.g. CARTON_MARKING) — drives the "Output type" filter.
  docType: string;
  variantKey: string;
  // True when this output is an Output Builder layout — so the AI can edit its
  // JSON. False for cover / general-info / coded outputs (no editable def).
  aiFixable: boolean;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  comment: string;
  reportedBy: string;
  reopenedCount: number;
  createdAtLabel: string;
  historyLabel: string;
  // Direct "edit this output" target: the Output Builder layout, or the
  // style's Prod Spec cover/general tab. null = no in-app editor (coded
  // template / print-spec catalogue output).
  editHref: string | null;
  editLabel: string;
  // Open the style's applied Prod Spec from the group header (new tab).
  prodSpecHref: string | null;
  // True when a non-FAILED asset for this output is newer than the rejection —
  // i.e. it's been re-generated since (catches auto/full re-runs too).
  regeneratedAfterRejection: boolean;
  regeneratedAtLabel: string | null;
  // True when the output's newest asset was APPROVED by a reviewer — the signal
  // behind the "Approved" pill (distinct from a ticket auto-resolved on removal).
  approved: boolean;
  // "Not generated — <rule>" / "Missing fields … fill in Monday: …" when this
  // ticket's output can't currently be generated (excluded by a doc-type rule
  // or missing required fields). null when it generates fine. Same text the
  // review screens show, so the admin knows re-running won't help.
  notGeneratedText: string | null;
  // Images the reviewer attached to the comment (served behind admin auth).
  attachments: { id: string; fileName: string; mimeType: string; url: string }[];
  searchBlob: string;
};

// One output of a style for the workbench's style overview: its name, whether
// it can be (re)generated now, when it was last made, and — for a rejected
// output — whether that's NEWER than the rejection ("fresh") or still the
// version the reviewer saw. Built server-side in page.tsx.
export type StyleOutputView = {
  variantKey: string; // base key
  name: string;
  declared: boolean;
  ready: boolean;
  missing: string[];
  // Skipped by a doc-type keyword rule (socks → no wash care); reason is the rule.
  excluded: boolean;
  exclusionReason: string | null;
  lastGeneratedLabel: string | null;
  rejected: boolean; // has an OPEN/IN_PROGRESS ticket
  regeneratedSinceRejection: boolean;
  reviewStatus: string | null;
};

// Which style-level action is mid-flight for a given style.
type StyleAction =
  | { kind: "regenAll" }
  | { kind: "regenAllFix" }
  | { kind: "markFixed" }
  | { kind: "regenOutput"; variantKey: string };

type StyleResult = { tone: "ok" | "warn" | "err"; msg: string };

type Status = "OPEN" | "IN_PROGRESS" | "FIXED" | "RESOLVED";

// Display buckets for the pills. A RESOLVED ticket whose output a reviewer
// APPROVED shows as "Approved" (the reviewer's action) rather than "Resolved"
// (which then means only "closed without an approval", e.g. the output was
// removed). An approval always resolves the ticket, so APPROVED stands in for
// RESOLVED — it never collides with the actionable OPEN/IN_PROGRESS/FIXED.
const DISPLAY_STATUSES = ["OPEN", "IN_PROGRESS", "FIXED", "APPROVED", "RESOLVED"] as const;
type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

function displayStatusOf(r: { status: Status; approved: boolean }): DisplayStatus {
  return r.status === "RESOLVED" && r.approved ? "APPROVED" : r.status;
}

const STATUS: Record<DisplayStatus, { tone: PillTone; label: string }> = {
  OPEN: { tone: "warn", label: "Open" },
  IN_PROGRESS: { tone: "accent", label: "In progress" },
  FIXED: { tone: "good", label: "Fixed" },
  APPROVED: { tone: "good", label: "Approved" },
  RESOLVED: { tone: "neutral", label: "Resolved" },
};

type StyleGroup = {
  styleId: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  prodSpecHref: string | null;
  tickets: TicketRow[];
  counts: Record<DisplayStatus, number>;
  // Non-resolved outputs in this style re-generated since they were rejected.
  regeneratedCount: number;
  latestLabel: string;
};

export function TicketList({
  rows,
  styleOutputs,
  view = "active",
}: {
  rows: TicketRow[];
  styleOutputs: Record<string, StyleOutputView[]>;
  // "active" = the workbench (OPEN/IN_PROGRESS, full actions). "history" =
  // read-only FIXED/RESOLVED record — no regenerate / mark-fixed surfaces.
  view?: "active" | "history";
}) {
  const isHistory = view === "history";
  const router = useRouter();
  // The ticket whose AI-fix dialog is open (null = closed).
  const [aiFixTicket, setAiFixTicket] = useState<TicketRow | null>(null);
  const [query, setQuery] = useState("");
  // Per-style action state: which action is running, and its last result.
  const [styleBusy, setStyleBusy] = useState<Record<string, StyleAction | null>>({});
  const [styleResult, setStyleResult] = useState<Record<string, StyleResult | null>>({});
  // Dynamic dimension filters (empty = All) — searchable multi-select facets
  // whose options derive from the tickets present, AND-ed with the search +
  // status filters below.
  const [customers, setCustomers] = useState<string[]>([]);
  const [businessAreas, setBusinessAreas] = useState<string[]>([]);
  const [outputTypes, setOutputTypes] = useState<string[]>([]);
  // "Select by comment" picker: the chosen comment-group keys. Choosing a
  // comment does NOT filter the list — it bulk-selects every actionable ticket
  // carrying that comment across all styles (see onSelectComments).
  const [selectedComments, setSelectedComments] = useState<string[]>([]);
  // Status pills are scoped to the view: Active workbenches OPEN/IN_PROGRESS;
  // History shows FIXED + (RESOLVED split into APPROVED/RESOLVED for display).
  // All of the view's statuses start enabled — the tab is the coarse filter,
  // the pills the fine one.
  const viewStatuses = useMemo<DisplayStatus[]>(
    () => (isHistory ? ["FIXED", "APPROVED", "RESOLVED"] : ["OPEN", "IN_PROGRESS"]),
    [isHistory],
  );
  const [enabled, setEnabled] = useState<Set<DisplayStatus>>(new Set(viewStatuses));
  // Style groups are open unless folded.
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(new Set());
  // The ticket shown on the right.
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);
  // Bumped after a re-run so the selected ticket's PDF preview reloads.
  const [previewVersion, setPreviewVersion] = useState(0);
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Bulk "mark fixed" selection (ticket ids) + in-flight progress + result.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number; regenerate: boolean } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{ fixed: number; failed: number } | null>(null);
  // List-level "Regenerate all & mark fixed" progress + result.
  const [listRun, setListRun] = useState<{ done: number; total: number } | null>(null);
  const [listSummary, setListSummary] = useState<
    { styles: number; fixed: number; failed: number; awaiting: number } | null
  >(null);

  // Only OPEN / IN_PROGRESS tickets can be marked fixed — FIXED/RESOLVED are done.
  const actionableIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.status === "OPEN" || r.status === "IN_PROGRESS") s.add(r.id);
    return s;
  }, [rows]);

  // Keep the selection honest as tickets settle (a refresh may flip some to FIXED).
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => actionableIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [actionableIds]);

  const selectedCount = useMemo(
    () => [...selected].filter((id) => actionableIds.has(id)).length,
    [selected, actionableIds],
  );

  const counts = useMemo(() => {
    const c: Record<DisplayStatus, number> = { OPEN: 0, IN_PROGRESS: 0, FIXED: 0, APPROVED: 0, RESOLVED: 0 };
    for (const r of rows) c[displayStatusOf(r)]++;
    return c;
  }, [rows]);

  // Facet options (searchable dropdowns) with per-value counts over the whole
  // backlog — same idiom as /styles and /prod-specs. Blank values are skipped.
  const customerOptions = useMemo<FacetOption[]>(() => facetOptionsFrom(rows, (r) => r.customerName), [rows]);
  const businessAreaOptions = useMemo<FacetOption[]>(
    () => facetOptionsFrom(rows, (r) => r.businessArea ?? ""),
    [rows],
  );
  const outputTypeOptions = useMemo<FacetOption[]>(
    () => facetOptionsFrom(rows, (r) => r.docType, outputTypeLabel),
    [rows],
  );

  // "Select by comment": group the still-to-do tickets by their exact comment
  // text. Each option shows the comment + how many tickets share it; choosing
  // it selects them all. Built over ALL rows so selection spans every style
  // regardless of the other filters. Most-repeated comment first — that's the
  // highest-value bulk action. Only OPEN/IN_PROGRESS tickets that have NOT
  // already been regenerated since rejection: a fixed or regenerated output no
  // longer needs a bulk re-fix, so it shouldn't pad the counts.
  const { commentOptions, commentTicketIds } = useMemo(() => {
    const byComment = new Map<string, string[]>();
    for (const r of rows) {
      if (r.status !== "OPEN" && r.status !== "IN_PROGRESS") continue;
      if (r.regeneratedAfterRejection) continue;
      const key = r.comment.trim();
      if (!key) continue;
      const ids = byComment.get(key);
      if (ids) ids.push(r.id);
      else byComment.set(key, [r.id]);
    }
    const options: FacetOption[] = [...byComment.entries()]
      .map(([value, ids]) => ({ value, label: value, count: ids.length }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { commentOptions: options, commentTicketIds: byComment };
  }, [rows]);

  // The comment checkmarks shown in the dropdown, derived (not stored) so they
  // stay honest as the backlog settles: a refresh that resolves a comment
  // group's last ticket drops its option, and intersecting here quietly clears
  // its checkmark + trigger-badge count without a sync effect.
  const validSelectedComments = useMemo(() => {
    const valid = new Set(commentOptions.map((o) => o.value));
    return selectedComments.filter((k) => valid.has(k));
  }, [commentOptions, selectedComments]);

  const filtered = useMemo(() => {
    // Split on commas / whitespace / newlines so a pasted list of POs (or
    // styles) matches as an OR — enter many at once, resolve them together.
    const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const customerSet = new Set(customers);
    const baSet = new Set(businessAreas);
    const typeSet = new Set(outputTypes);
    return rows.filter(
      (r) =>
        enabled.has(displayStatusOf(r)) &&
        (terms.length === 0 || terms.some((t) => r.searchBlob.includes(t))) &&
        (customerSet.size === 0 || customerSet.has(r.customerName)) &&
        (baSet.size === 0 || (r.businessArea != null && baSet.has(r.businessArea))) &&
        (typeSet.size === 0 || typeSet.has(r.docType)),
    );
  }, [rows, query, enabled, customers, businessAreas, outputTypes]);

  // Group the (already newest-first) filtered tickets by style. Insertion
  // order = first-seen order = most-recently-rejected style first, and the
  // first ticket in each group is that style's newest rejection.
  const groups = useMemo<StyleGroup[]>(() => {
    const map = new Map<string, StyleGroup>();
    for (const r of filtered) {
      let g = map.get(r.styleId);
      if (!g) {
        g = {
          styleId: r.styleId,
          styleName: r.styleName,
          styleNumber: r.styleNumber,
          customerName: r.customerName,
          prodSpecHref: r.prodSpecHref,
          tickets: [],
          counts: { OPEN: 0, IN_PROGRESS: 0, FIXED: 0, APPROVED: 0, RESOLVED: 0 },
          regeneratedCount: 0,
          latestLabel: r.createdAtLabel,
        };
        map.set(r.styleId, g);
      }
      g.tickets.push(r);
      g.counts[displayStatusOf(r)]++;
      if (r.regeneratedAfterRejection && r.status !== "RESOLVED") g.regeneratedCount++;
    }
    return [...map.values()];
  }, [filtered]);

  // The ticket on the right: the one picked, or the first in view.
  const current = filtered.find((r) => r.id === selectedId) ?? filtered[0] ?? null;

  function toggleStatus(s: DisplayStatus) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function toggleGroup(styleId: string) {
    setFoldedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(styleId)) next.delete(styleId);
      else next.add(styleId);
      return next;
    });
  }

  async function act(row: TicketRow, action: "start" | "rerun" | "fix") {
    setErrors((e) => ({ ...e, [row.id]: "" }));
    setNotes((n) => ({ ...n, [row.id]: "" }));
    setPending({ id: row.id, action });
    try {
      const res = await fetch(`/api/admin/rejection-tickets/${row.id}/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        latestAsset?: { placeholderCount: number } | null;
      };
      if (!res.ok) {
        setErrors((e) => ({ ...e, [row.id]: body.error ?? `HTTP ${res.status}` }));
        return;
      }
      if (action === "rerun") {
        const ph = body.latestAsset?.placeholderCount ?? 0;
        setNotes((n) => ({
          ...n,
          [row.id]:
            ph > 0
              ? `Re-generated, but ${ph} placeholder(s) remain: the data gap isn't fixed yet.`
              : "Re-generated. Check the fresh preview.",
        }));
      }
      // A re-run replaces the asset (new job) — reload the preview too.
      if (action === "rerun" || action === "fix") setPreviewVersion((v) => v + 1);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setManySelected(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // Picking comment-groups in the "Select by comment" dropdown bulk-selects
  // every actionable ticket carrying those comments (across all styles) for the
  // bulk mark-fixed actions — it does NOT filter the list. We diff old→new so
  // toggling a comment off releases exactly its tickets.
  function onSelectComments(next: string[]) {
    const nextSet = new Set(next);
    const prev = validSelectedComments;
    setSelected((prevSelected) => {
      const out = new Set(prevSelected);
      for (const key of next) {
        if (prev.includes(key)) continue;
        for (const id of commentTicketIds.get(key) ?? []) out.add(id);
      }
      for (const key of prev) {
        if (nextSet.has(key)) continue;
        for (const id of commentTicketIds.get(key) ?? []) out.delete(id);
      }
      return out;
    });
    setSelectedComments(next);
  }

  // Clear both the ticket selection and the comment-dropdown checkmarks that
  // may have driven it (the bar's "Clear", and after a bulk action completes).
  function clearSelection() {
    setSelected(new Set());
    setSelectedComments([]);
  }

  // Bulk action over the selected tickets, run sequentially so each gets its own
  // request budget (renders are slow) and commits independently — a mid-way stop
  // still leaves the finished ones FIXED. Sequential also dodges runTicketJob's
  // "a job is already in flight for this style" guard.
  //   • regenerate=false → "Mark fixed & notify": flip status + notify, NO re-render.
  //   • regenerate=true  → "Regenerate, mark fixed & notify": re-render each output first.
  async function bulkFix(regenerate: boolean) {
    const ids = [...selected].filter((id) => actionableIds.has(id));
    if (ids.length === 0 || bulk) return;
    setBulkSummary(null);
    setBulk({ done: 0, total: ids.length, regenerate });
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`/api/admin/rejection-tickets/${id}/fix`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ regenerate }),
        });
        if (!res.ok) failed++;
      } catch {
        failed++;
      }
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
    }
    setBulk(null);
    clearSelection();
    setBulkSummary({ fixed: ids.length - failed, failed });
    router.refresh();
  }

  // List-level "Regenerate all & mark fixed": run the per-style regenerate-all
  // resolve over EVERY style currently in the list (so it respects the active
  // filters — what you see is what runs). Sequential per style: concurrent jobs
  // for one style are guarded and each slow render needs its own budget. Uses
  // the same resolve-rejections path as the per-style button, which re-renders
  // every rejected output and posts ONE re-review notice per style — and is
  // status-aware, so FIXED tickets get re-done too.
  async function regenerateAllInList() {
    if (listRun || bulk) return;
    const styleIds = groups.map((g) => g.styleId);
    if (styleIds.length === 0) return;
    if (
      !window.confirm(
        `Regenerate every rejected output across ${styleIds.length} style${styleIds.length === 1 ? "" : "s"} in this list and send them back for review?\n\n` +
          `This re-renders all rejected outputs and posts a re-review notice to the reviewer (one per style). It can take a while.`,
      )
    )
      return;
    setListSummary(null);
    setListRun({ done: 0, total: styleIds.length });
    let fixed = 0;
    let failed = 0;
    let awaiting = 0;
    for (const styleId of styleIds) {
      try {
        const res = await fetch(`/api/admin/styles/${styleId}/resolve-rejections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ regenerateAll: true }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          fixed?: unknown[];
          awaitingData?: unknown[];
          failed?: unknown[];
        };
        if (!res.ok) failed++;
        else {
          fixed += body.fixed?.length ?? 0;
          awaiting += body.awaitingData?.length ?? 0;
          failed += body.failed?.length ?? 0;
        }
      } catch {
        failed++;
      }
      setListRun((s) => (s ? { ...s, done: s.done + 1 } : s));
    }
    setListRun(null);
    setListSummary({ styles: styleIds.length, fixed, failed, awaiting });
    router.refresh();
  }

  // Style-level actions. Regenerate (all / one output) hits the rerun route;
  // mark-fixed (smart / regenerate-all-first) hits resolve-rejections, which
  // re-renders only the stale outputs and sends ONE re-review notice.
  async function styleAct(styleId: string, action: StyleAction) {
    if (styleBusy[styleId]) return;
    setStyleResult((r) => ({ ...r, [styleId]: null }));
    setStyleBusy((b) => ({ ...b, [styleId]: action }));
    try {
      let res: Response;
      if (action.kind === "regenAll" || action.kind === "regenOutput") {
        res = await fetch(`/api/admin/styles/${styleId}/rerun`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action.kind === "regenOutput" ? { variantKeys: [action.variantKey] } : {}),
        });
      } else {
        res = await fetch(`/api/admin/styles/${styleId}/resolve-rejections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ regenerateAll: action.kind === "regenAllFix" }),
        });
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        jobsFailed?: number;
        fixed?: unknown[];
        awaitingData?: Array<{ outputName: string }>;
        resolvedOrphan?: unknown[];
        resolvedExcluded?: unknown[];
        failed?: unknown[];
      };
      if (!res.ok) {
        setStyleResult((r) => ({ ...r, [styleId]: { tone: "err", msg: body.error ?? `HTTP ${res.status}` } }));
        return;
      }
      if (action.kind === "regenAll" || action.kind === "regenOutput") {
        const failedN = body.jobsFailed ?? 0;
        setStyleResult((r) => ({
          ...r,
          [styleId]:
            failedN > 0
              ? { tone: "warn", msg: `Regenerated with ${failedN} failure(s). Check the job log.` }
              : { tone: "ok", msg: "Regenerated. See the fresh times below." },
        }));
      } else {
        const fixed = body.fixed?.length ?? 0;
        const waiting = body.awaitingData ?? [];
        const orphan = body.resolvedOrphan?.length ?? 0;
        const excluded = body.resolvedExcluded?.length ?? 0;
        const failedN = body.failed?.length ?? 0;
        const parts: string[] = [];
        if (fixed > 0) parts.push(`${fixed} marked fixed & reviewer notified`);
        if (orphan > 0) parts.push(`${orphan} auto-resolved (output removed)`);
        if (excluded > 0) parts.push(`${excluded} auto-resolved (excluded by rule)`);
        if (waiting.length > 0)
          parts.push(`${waiting.length} awaiting data (${waiting.map((w) => w.outputName).join(", ")})`);
        if (failedN > 0) parts.push(`${failedN} couldn't be regenerated`);
        const tone: StyleResult["tone"] = failedN > 0 || (waiting.length > 0 && fixed === 0) ? "warn" : "ok";
        setStyleResult((r) => ({
          ...r,
          [styleId]: { tone, msg: parts.length ? parts.join(" · ") : "Nothing to mark fixed." },
        }));
      }
      router.refresh();
    } catch {
      setStyleResult((r) => ({ ...r, [styleId]: { tone: "err", msg: "Request failed. Try again." } }));
    } finally {
      setStyleBusy((b) => ({ ...b, [styleId]: null }));
    }
  }

  const currentGroup = current ? groups.find((g) => g.styleId === current.styleId) ?? null : null;

  return (
    <div className="flex flex-col xl:min-h-0 xl:flex-1">
      {/* Find and narrow. */}
      <div data-section="Rejection filters" className="border-line flex flex-wrap items-center gap-2 border-b px-6 py-2.5">
        <label className="relative">
          <span className="sr-only">Search the rejection log</span>
          <Search size={13} aria-hidden="true" className="text-faint pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search style, PO, output, comment… (paste many)"
            className="border-line bg-surface text-ink placeholder:text-faint focus:border-accent h-7 w-80 max-w-full rounded-md border pr-2 pl-7 text-[12px] outline-none"
          />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Status">
          {viewStatuses.map((s) => {
            const on = enabled.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                aria-pressed={on}
                title={on ? `Hide ${STATUS[s].label.toLowerCase()} comments` : `Show ${STATUS[s].label.toLowerCase()} comments`}
                className="rounded-full"
              >
                <Pill tone={on ? STATUS[s].tone : "neutral"} dot={on} className={on ? "" : "opacity-60"}>
                  {STATUS[s].label} <span className="tabular-nums">{counts[s]}</span>
                </Pill>
              </button>
            );
          })}
        </div>
        <FacetFilter label="Customer" options={customerOptions} selected={customers} onChange={setCustomers} searchable />
        <FacetFilter
          label="Business area"
          options={businessAreaOptions}
          selected={businessAreas}
          onChange={setBusinessAreas}
          searchable
        />
        <FacetFilter label="Output type" options={outputTypeOptions} selected={outputTypes} onChange={setOutputTypes} searchable />
        {commentOptions.length > 0 ? (
          <FacetFilter
            label="Select by comment"
            options={commentOptions}
            selected={validSelectedComments}
            onChange={onSelectComments}
            searchable
            wide
            wrapOptions
          />
        ) : null}
        <span className="flex-1" />
        <span className="text-muted text-[12px] tabular-nums">
          {groups.length} style{groups.length === 1 ? "" : "s"} · {filtered.length} comment{filtered.length === 1 ? "" : "s"}
        </span>
        {!isHistory && groups.length > 0 ? (
          <Button
            size="sm"
            onClick={regenerateAllInList}
            disabled={listRun !== null || bulk !== null}
            title="Re-render every rejected output across all styles in this list and send them back to the reviewer"
          >
            <RefreshCw size={13} aria-hidden="true" />
            {listRun ? `Regenerating… ${listRun.done}/${listRun.total}` : `Regenerate all & mark fixed`}
          </Button>
        ) : null}
      </div>

      {bulkSummary || listSummary ? (
        <div className="border-line flex flex-col gap-1 border-b px-6 py-2 text-[12px]">
          {bulkSummary ? (
            <ResultLine
              tone={bulkSummary.failed > 0 ? "warn" : "ok"}
              onDismiss={() => setBulkSummary(null)}
              text={`${bulkSummary.fixed} marked fixed and reviewer notified${
                bulkSummary.failed > 0 ? ` · ${bulkSummary.failed} failed (still open, try again)` : ""
              }.`}
            />
          ) : null}
          {listSummary ? (
            <ResultLine
              tone={listSummary.failed > 0 ? "warn" : "ok"}
              onDismiss={() => setListSummary(null)}
              text={`${listSummary.styles} style${listSummary.styles === 1 ? "" : "s"} processed · ${listSummary.fixed} output${
                listSummary.fixed === 1 ? "" : "s"
              } re-rendered and sent for review${listSummary.awaiting > 0 ? ` · ${listSummary.awaiting} awaiting data` : ""}${
                listSummary.failed > 0 ? ` · ${listSummary.failed} failed (still open, retry)` : ""
              }.`}
            />
          ) : null}
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p className="text-muted mx-6 my-6 rounded-xl border border-dashed border-[var(--line)] px-4 py-10 text-center text-[13px]">
          {rows.length === 0
            ? isHistory
              ? "Nothing here yet. Comments land in History once they're marked fixed or approved."
              : "No open comments. When a reviewer requests changes, their comment lands here."
            : "Nothing matches the current filters."}
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_480px] xl:grid-rows-[minmax(0,1fr)]">
          {/* The comments, grouped by style. */}
          <div data-section="Rejection list" className="relative min-w-0 xl:overflow-y-auto">
            {groups.map((g) => (
              <StyleBlock
                key={g.styleId}
                group={g}
                // A search drills into every matching style.
                open={query.trim() !== "" || !foldedGroups.has(g.styleId)}
                onToggle={() => toggleGroup(g.styleId)}
                currentId={current?.id ?? null}
                onPick={(id) => {
                  setSelectedId(id);
                  // Stacked (narrow) layout: the comment is below the list, so bring it up.
                  if (window.matchMedia("(max-width: 1023px)").matches) {
                    document.getElementById("ticket-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                }}
                selected={selected}
                onToggleSelect={toggleSelect}
                onSetManySelected={setManySelected}
                bulkBusy={bulk !== null}
                readOnly={isHistory}
              />
            ))}

            {selectedCount > 0 || bulk ? (
              <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center px-4 pt-4">
                <div className="border-line bg-surface pointer-events-auto flex items-center gap-2 rounded-full border py-1.5 pr-2 pl-4 shadow-[var(--shadow-pop)]">
                  {bulk ? (
                    <span className="text-ink text-[12px]">
                      {bulk.regenerate ? "Regenerating and notifying…" : "Marking fixed and notifying…"} {bulk.done}/{bulk.total}
                    </span>
                  ) : (
                    <>
                      <span className="text-ink text-[12px] font-medium">{selectedCount} selected</span>
                      <Button
                        size="sm"
                        onClick={() => bulkFix(false)}
                        title="Mark each selected comment fixed and notify the reviewer, WITHOUT re-rendering (use when the outputs are already up to date)"
                      >
                        Mark fixed &amp; notify
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => bulkFix(true)}
                        title="Re-render each selected output, then mark it fixed and notify the reviewer"
                      >
                        Regenerate, mark fixed &amp; notify
                      </Button>
                      <Button size="sm" variant="ghost" onClick={clearSelection}>
                        Clear
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {/* The selected comment. */}
          <aside
            id="ticket-detail"
            aria-label="Selected comment"
            className="scroll-mt-12 border-line bg-bg border-t lg:sticky lg:top-12 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:border-t-0 lg:border-l xl:static xl:max-h-none"
          >
            {current ? (
              <TicketDetail
                key={current.id}
                row={current}
                previewVersion={previewVersion}
                pendingAction={pending?.id === current.id ? pending.action : null}
                error={errors[current.id] || null}
                note={notes[current.id] || null}
                onAct={(action) => act(current, action)}
                onAiFix={setAiFixTicket}
                readOnly={isHistory}
                style={
                  !isHistory && currentGroup ? (
                    <StyleOverview
                      group={currentGroup}
                      outputs={styleOutputs[currentGroup.styleId] ?? []}
                      busy={styleBusy[currentGroup.styleId] ?? null}
                      result={styleResult[currentGroup.styleId] ?? null}
                      onAct={(action) => styleAct(currentGroup.styleId, action)}
                      bulkBusy={bulk !== null}
                    />
                  ) : null
                }
              />
            ) : null}
          </aside>
        </div>
      )}

      {aiFixTicket ? (
        <AiFixDialog
          ticketId={aiFixTicket.id}
          outputName={aiFixTicket.outputName}
          styleName={aiFixTicket.styleName}
          styleNumber={aiFixTicket.styleNumber}
          comment={aiFixTicket.comment}
          onClose={() => setAiFixTicket(null)}
          onApplied={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

function ResultLine({ tone, text, onDismiss }: { tone: "ok" | "warn"; text: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className={tone === "warn" ? "text-warn" : "text-good"}>{text}</span>
      <button type="button" onClick={onDismiss} className="text-muted hover:text-ink ml-auto underline">
        Dismiss
      </button>
    </div>
  );
}

// One style in the list: a header with its counts and a fold, then its comments.
function StyleBlock({
  group,
  open,
  onToggle,
  currentId,
  onPick,
  selected,
  onToggleSelect,
  onSetManySelected,
  bulkBusy,
  readOnly,
}: {
  group: StyleGroup;
  open: boolean;
  onToggle: () => void;
  currentId: string | null;
  onPick: (id: string) => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onSetManySelected: (ids: string[], on: boolean) => void;
  bulkBusy: boolean;
  // History view: read-only (no selection column).
  readOnly: boolean;
}) {
  const selectableIds = readOnly
    ? []
    : group.tickets.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS").map((t) => t.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  // Any comment inside this style picked for the bulk bar — flag the header so
  // a comment-driven selection that lands in a folded style is still visible.
  const anySelected = selectableIds.some((id) => selected.has(id));
  return (
    <section className="border-line border-b">
      <div
        className={`border-line bg-sidebar sticky top-12 z-10 flex xl:top-0 items-center gap-2 border-b px-4 py-2 ${
          anySelected ? "shadow-[inset_3px_0_0_var(--accent)]" : ""
        }`}
      >
        {readOnly ? null : (
          <input
            type="checkbox"
            className="accent-[var(--accent)] size-3.5 shrink-0 cursor-pointer"
            checked={allSelected}
            disabled={selectableIds.length === 0 || bulkBusy}
            onChange={(e) => onSetManySelected(selectableIds, e.target.checked)}
            aria-label={allSelected ? "Deselect all in this style" : "Select all open comments in this style"}
          />
        )}
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`text-faint shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="min-w-0">
            <span className="text-ink block truncate text-[13px] font-medium">
              {group.styleName} <span className="text-faint font-mono text-[11px] font-normal">{group.styleNumber}</span>
            </span>
            {group.customerName ? <span className="text-muted block truncate text-[12px]">{group.customerName}</span> : null}
          </span>
        </button>
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          {group.regeneratedCount > 0 ? (
            <Pill tone="good" title={`${group.regeneratedCount} output(s) re-generated since rejected`}>
              {group.regeneratedCount} regenerated
            </Pill>
          ) : null}
          {DISPLAY_STATUSES.map((s) =>
            group.counts[s] > 0 ? (
              <Pill key={s} tone={STATUS[s].tone}>
                {group.counts[s]} {STATUS[s].label.toLowerCase()}
              </Pill>
            ) : null,
          )}
        </div>
        <span className="text-faint hidden shrink-0 text-[12px] md:inline">{group.latestLabel}</span>
        {group.prodSpecHref ? (
          <a
            href={group.prodSpecHref}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this style's prod spec (new tab)"
            className="text-faint hover:bg-subtle hover:text-ink inline-flex size-7 shrink-0 items-center justify-center rounded-md"
          >
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </div>

      {open ? (
        <ul>
          {group.tickets.map((row) => {
            const actionable = !readOnly && (row.status === "OPEN" || row.status === "IN_PROGRESS");
            const ds = displayStatusOf(row);
            const entries = splitTicketComment(row.comment);
            const active = currentId === row.id;
            return (
              <li key={row.id} className="border-line border-b last:border-b-0">
                <div
                  className={`flex items-start gap-3 px-4 py-2.5 transition-colors duration-150 ${
                    active ? "bg-active" : "hover:bg-subtle"
                  }`}
                >
                  {readOnly ? null : (
                    <span className="flex h-5 w-3.5 shrink-0 items-center">
                      {actionable ? (
                        <input
                          type="checkbox"
                          className="accent-[var(--accent)] size-3.5 cursor-pointer"
                          checked={selected.has(row.id)}
                          disabled={bulkBusy}
                          onChange={() => onToggleSelect(row.id)}
                          aria-label={`Select ${row.outputName} for a bulk fix`}
                        />
                      ) : null}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onPick(row.id)}
                    aria-current={active ? "true" : undefined}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="text-ink block truncate text-[13px] font-medium">
                      {row.outputName} <span className="text-faint font-normal">· {outputTypeLabel(row.docType)}</span>
                    </span>
                    <span className="text-muted mt-0.5 line-clamp-2 block text-[12px]">&ldquo;{entries.at(-1)?.text ?? row.comment}&rdquo;</span>
                    <span className="text-faint mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                      <span data-private>
                        {row.reportedBy} · {row.createdAtLabel}
                      </span>
                      {row.poNumber ? <span>PO {row.poNumber}</span> : null}
                      {entries.length > 1 ? (
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare size={11} aria-hidden="true" />
                          {entries.length}
                        </span>
                      ) : null}
                      {row.attachments.length > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <ImageIcon size={11} aria-hidden="true" />
                          {row.attachments.length}
                        </span>
                      ) : null}
                      {row.regeneratedAfterRejection && row.status !== "RESOLVED" ? (
                        <span className="text-good">Regenerated since</span>
                      ) : null}
                      {row.notGeneratedText ? <span className="text-warn">Not generated</span> : null}
                    </span>
                  </button>
                  <Pill tone={STATUS[ds].tone} className="mt-0.5">
                    {STATUS[ds].label}
                    {row.reopenedCount > 0 ? ` ×${row.reopenedCount + 1}` : ""}
                  </Pill>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

// The selected comment: what the reviewer saw, what they said, and what to do.
function TicketDetail({
  row,
  previewVersion,
  pendingAction,
  error,
  note,
  onAct,
  onAiFix,
  readOnly,
  style,
}: {
  row: TicketRow;
  previewVersion: number;
  pendingAction: string | null;
  error: string | null;
  note: string | null;
  onAct: (action: "start" | "rerun" | "fix") => void;
  onAiFix: (row: TicketRow) => void;
  readOnly: boolean;
  style: ReactNode;
}) {
  const actionable = !readOnly && (row.status === "OPEN" || row.status === "IN_PROGRESS");
  const ds = displayStatusOf(row);
  const entries = splitTicketComment(row.comment);
  return (
    <div className="reveal flex flex-col gap-5 p-5">
      <div>
        <p className="text-muted text-[12px]">
          {row.styleName}
          {row.poNumber ? ` · PO ${row.poNumber}` : ""}
        </p>
        <h2 className="text-ink mt-0.5 text-[16px] leading-6 font-semibold">{row.outputName}</h2>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Pill tone={STATUS[ds].tone} dot>
            {STATUS[ds].label}
            {row.reopenedCount > 0 ? ` · reopened ×${row.reopenedCount}` : ""}
          </Pill>
          <Pill>{row.customerName}</Pill>
          {row.businessArea ? <Pill>{row.businessArea}</Pill> : null}
          <Pill>{outputTypeLabel(row.docType)}</Pill>
        </div>
      </div>

      <TicketPreview key={`${row.id}:${previewVersion}`} ticketId={row.id} outputName={row.outputName} />

      <div className="flex flex-wrap gap-2">
        {row.editHref ? (
          <a
            href={row.editHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass("secondary", "sm")}
            title="Edit the source of this output in a new tab, then come back and re-run"
          >
            {row.editLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : null}
        <Link href={`/styles/${row.styleId}/review`} className={buttonClass("ghost", "sm")}>
          Review screen
        </Link>
        <Link href={`/styles/${row.styleId}`} className={buttonClass("ghost", "sm")}>
          Style
        </Link>
        {!readOnly && row.aiFixable ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAiFix(row)}
            title="Let the AI propose an edit to this layout from the comment: preview before and after, and keep it if you like it"
          >
            <Sparkles size={13} aria-hidden="true" />
            Suggest a fix
          </Button>
        ) : null}
      </div>

      {/* The conversation, as the reviewer wrote it. */}
      <section className="flex flex-col gap-2">
        <h3 className="text-ink text-[12px] font-medium">Comments</h3>
        <ol className="flex flex-col gap-2">
          {entries.map((entry, i) => (
            <li key={i} className="border-line bg-surface rounded-lg border px-3 py-2.5">
              <div className="text-muted flex items-center gap-1.5 text-[12px]">
                {i === 0 ? (
                  <>
                    <UserAvatar name={row.reportedBy} size="xs" />
                    <span data-private className="text-ink font-medium">
                      {row.reportedBy}
                    </span>
                    <span>· {row.createdAtLabel}</span>
                  </>
                ) : (
                  <span>Added {entry.stamp}</span>
                )}
              </div>
              <p className="text-ink mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{entry.text}</p>
            </li>
          ))}
        </ol>
        {row.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {row.attachments.map((a) => (
              <a
                key={a.id}
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${a.fileName}, open full size`}
                className="border-line bg-subtle hover:border-faint block size-16 overflow-hidden rounded-md border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- admin-only attachment thumbnail, served from our API */}
                <img src={a.url} alt={a.fileName} className="size-full object-cover" />
              </a>
            ))}
          </div>
        ) : null}
        {row.notGeneratedText ? (
          <p className="bg-warn-soft text-warn rounded-md px-3 py-2 text-[12px] leading-relaxed">{row.notGeneratedText}</p>
        ) : null}
        <p className="text-faint text-[11px] leading-relaxed">{row.historyLabel}</p>
      </section>

      {actionable ? (
        <section data-section="Ticket actions" className="flex flex-col gap-2">
          <Button
            variant="primary"
            onClick={() => onAct("fix")}
            disabled={pendingAction !== null}
            title="Final re-run of this output, then tell the reviewer it's ready for another look"
          >
            {pendingAction === "fix" ? "Fixing…" : "Re-run, mark fixed & notify"}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => onAct("rerun")}
              disabled={pendingAction !== null}
              title="Regenerate this output WITHOUT notifying the reviewer"
            >
              <RefreshCw size={13} aria-hidden="true" />
              {pendingAction === "rerun" ? "Re-running…" : "Re-run only"}
            </Button>
            {row.status === "OPEN" ? (
              <Button onClick={() => onAct("start")} disabled={pendingAction !== null} title="Show the reviewer you're on it">
                {pendingAction === "start" ? "Starting…" : "Start work"}
              </Button>
            ) : (
              <span className="text-muted flex items-center justify-center text-[12px]">You&rsquo;re on it</span>
            )}
          </div>
          <p className="text-faint text-[12px] leading-relaxed">
            Fix the data or the layout first. Approving the output on the review screen resolves this comment.
          </p>
        </section>
      ) : row.status === "FIXED" ? (
        <p className="text-muted text-[12px]">
          Waiting for the reviewer to look again; they were notified. Approval resolves it, another comment reopens it.
        </p>
      ) : row.status === "RESOLVED" ? (
        <p className="text-muted text-[12px]">
          {row.approved
            ? "Approved: the reviewer approved this output."
            : "Resolved: closed without a reviewer approval (for example, the output was removed)."}
        </p>
      ) : null}
      {error ? <p className="text-bad text-[12px]">{error}</p> : null}
      {note ? <p className="text-good text-[12px]">{note}</p> : null}

      {style}
    </div>
  );
}

// The rejected PDF (what the reviewer saw) and, when a re-run produced a newer
// one, the latest — fetched when the comment is opened.
function TicketPreview({ ticketId, outputName }: { ticketId: string; outputName: string }) {
  const [state, setState] = useState<TicketAssets | "loading" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/rejection-tickets/${ticketId}/assets`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        const body = (await res.json()) as TicketAssets;
        if (!cancelled) setState({ rejected: body.rejected, latest: body.latest });
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  if (state === "loading") return <div className="skeleton h-72 rounded-lg" aria-label="Loading the PDF" />;
  if (state === "error") return <p className="text-bad text-[12px]">Couldn&apos;t load the PDF preview.</p>;
  const { rejected, latest } = state;
  // Show the latest version separately only when a re-run produced a different
  // job than the one that was rejected.
  const latestDiffers = !!latest && (!rejected || latest.jobId !== rejected.jobId);
  if (!rejected && !latest) return <p className="text-muted text-[12px]">No generated PDF for this output right now.</p>;
  return (
    <div className="flex flex-col gap-3">
      {rejected ? (
        <PreviewBlock title="What the reviewer saw" asset={rejected} outputName={outputName} />
      ) : (
        <p className="text-warn text-[12px]">The originally rejected PDF is no longer stored. The latest version is below.</p>
      )}
      {latestDiffers ? <PreviewBlock title="Latest re-run" asset={latest!} outputName={outputName} /> : null}
    </div>
  );
}

// One labelled PDF preview (header + inline iframe).
function PreviewBlock({ title, asset, outputName }: { title: string; asset: AssetView; outputName: string }) {
  const previewUrl = `/api/admin/jobs/${asset.jobId}/preview?${asset.previewQuery}`;
  return (
    <div className="border-line bg-surface overflow-hidden rounded-lg border">
      <div className="border-line flex items-center justify-between gap-3 border-b px-3 py-1.5">
        <span className="text-muted min-w-0 truncate text-[12px]">
          <span className="text-ink font-medium">{title}</span> · {asset.generatedAtLabel} ·{" "}
          {asset.reviewStatus.toLowerCase().replace("_", " ")}
          {asset.placeholderCount > 0 ? <span className="text-warn"> · {asset.placeholderCount} placeholder(s)</span> : null}
        </span>
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "sm", "shrink-0")}>
          Open
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
      <iframe src={previewUrl} className="block h-80 w-full bg-white" title={`${title}: ${outputName}`} />
    </div>
  );
}

// The selected comment's style as a whole: re-run or close every comment on it
// at once, and see each output's freshness.
function StyleOverview({
  group,
  outputs,
  busy,
  result,
  onAct,
  bulkBusy,
}: {
  group: StyleGroup;
  outputs: StyleOutputView[];
  busy: StyleAction | null;
  result: StyleResult | null;
  onAct: (action: StyleAction) => void;
  bulkBusy: boolean;
}) {
  const openCount = group.tickets.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS").length;
  return (
    <section data-section="Style overview" className="border-line flex flex-col gap-3 border-t pt-5">
      <div>
        <h3 className="text-ink text-[13px] font-semibold">This style</h3>
        <p className="text-muted text-[12px]">
          {group.styleName} · {openCount} open comment{openCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => onAct({ kind: "regenAll" })}
          disabled={busy !== null || bulkBusy}
          title="Re-render the whole style: cover, general info and every output"
        >
          {busy?.kind === "regenAll" ? "Regenerating all…" : "Regenerate all"}
        </Button>
        {openCount > 0 ? (
          <>
            <Button
              size="sm"
              onClick={() => onAct({ kind: "markFixed" })}
              disabled={busy !== null || bulkBusy}
              title="Mark this style's rejected outputs fixed and notify the reviewer; re-renders only the ones not already refreshed since their rejection"
            >
              {busy?.kind === "markFixed" ? "Marking fixed…" : "Mark all fixed & notify"}
            </Button>
            <Button
              size="sm"
              onClick={() => onAct({ kind: "regenAllFix" })}
              disabled={busy !== null || bulkBusy}
              title="Re-render everything, then mark all rejected outputs fixed and notify the reviewer"
            >
              {busy?.kind === "regenAllFix" ? "Regenerating & fixing…" : "Regenerate all & mark fixed"}
            </Button>
          </>
        ) : null}
      </div>
      {result ? (
        <p className={`text-[12px] ${result.tone === "err" ? "text-bad" : result.tone === "warn" ? "text-warn" : "text-good"}`}>
          {result.msg}
        </p>
      ) : null}
      {outputs.length > 0 ? (
        <ul className="border-line bg-surface divide-line divide-y rounded-lg border">
          {outputs.map((o) => (
            <li key={o.variantKey} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-ink truncate">{o.name}</span>
                {o.rejected ? <Pill tone="warn">Open comment</Pill> : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <OutputFreshness o={o} />
                {o.rejected && o.declared && o.ready && !o.regeneratedSinceRejection ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onAct({ kind: "regenOutput", variantKey: o.variantKey })}
                    disabled={busy !== null || bulkBusy}
                    title="Regenerate just this output"
                  >
                    {busy?.kind === "regenOutput" && busy.variantKey === o.variantKey ? "…" : "Re-run"}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// Freshness for one output in the style overview: regenerated since its
// rejection, still the version the reviewer saw, can't generate (and why), or
// just when it was last made.
function OutputFreshness({ o }: { o: StyleOutputView }) {
  // Excluded by a doc-type rule wins — it's never generated, so show the rule
  // (the same text the review screens show) rather than freshness.
  if (o.excluded) {
    return (
      <span className="text-warn max-w-56 truncate" title={o.exclusionReason ?? undefined}>
        {o.exclusionReason ?? "Not generated: skipped by a document-type rule"}
      </span>
    );
  }
  if (o.rejected && o.regeneratedSinceRejection) {
    return (
      <span className="text-good whitespace-nowrap">
        Regenerated since{o.lastGeneratedLabel ? ` · ${o.lastGeneratedLabel}` : ""}
      </span>
    );
  }
  if (o.rejected && !o.declared) {
    return (
      <span className="text-warn whitespace-nowrap" title="This output was removed from the prod spec; marking it fixed resolves the comment.">
        Removed from the spec
      </span>
    );
  }
  // Missing required fields → can't generate. Surfaced for ANY not-ready output
  // (not just rejected ones), naming the Monday fields to fill in.
  if (!o.ready) {
    return (
      <span className="text-warn max-w-56 truncate" title={`Please fill these in Monday: ${o.missing.join(", ")}`}>
        Missing fields{o.missing.length ? `: ${o.missing.slice(0, 3).join(", ")}${o.missing.length > 3 ? "…" : ""}` : ""}
      </span>
    );
  }
  if (o.rejected) return <span className="text-warn whitespace-nowrap">Still the rejected version</span>;
  return (
    <span className="text-faint whitespace-nowrap">{o.lastGeneratedLabel ? `Generated ${o.lastGeneratedLabel}` : "Not generated"}</span>
  );
}

// Build sorted FacetOptions (value + per-value count) from the rows, skipping
// blank values. An optional formatter maps the raw value to a display label
// (e.g. docType "CARTON_MARKING" → "Carton marking").
function facetOptionsFrom(
  rows: TicketRow[],
  pick: (r: TicketRow) => string,
  format?: (value: string) => string,
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = pick(r);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: format ? format(value) : value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
