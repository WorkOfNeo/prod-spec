"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { outputTypeLabel } from "./rejection-filters";
import { FacetFilter, type FacetOption } from "@/components/facet-filter";

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
// is expanded: the originally-rejected PDF plus the latest one for the output.
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
  // Images the reviewer attached to the comment (served behind admin auth).
  attachments: { id: string; fileName: string; mimeType: string; url: string }[];
  searchBlob: string;
};

// One output of a style for the rejection workbench's at-a-glance overview:
// its name, whether it can be (re)generated now, when it was last made, and —
// for a rejected output — whether that's NEWER than the rejection ("fresh") or
// still the version the reviewer saw. Built server-side in page.tsx.
export type StyleOutputView = {
  variantKey: string; // base key
  name: string;
  declared: boolean;
  ready: boolean;
  missing: string[];
  lastGeneratedLabel: string | null;
  rejected: boolean; // has an OPEN/IN_PROGRESS ticket
  regeneratedSinceRejection: boolean;
  reviewStatus: string | null;
};

// Per-ticket lazy-load state: undefined = not fetched, "loading"/"error"
// = in-flight/failed, object = the fetched { rejected, latest }.
type AssetState = TicketAssets | "loading" | "error" | undefined;

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

const STATUS_PILLS: Record<DisplayStatus, string> = {
  OPEN: "border-red-200 bg-red-50 text-red-700",
  IN_PROGRESS: "border-amber-200 bg-amber-50 text-amber-700",
  FIXED: "border-blue-200 bg-blue-50 text-blue-700",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  RESOLVED: "border-zinc-200 bg-zinc-100 text-zinc-600",
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
}: {
  rows: TicketRow[];
  styleOutputs: Record<string, StyleOutputView[]>;
}) {
  const router = useRouter();
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
  // APPROVED + RESOLVED are hidden by default — the workbench shows actionable
  // threads; their pill counts still give the at-a-glance overview.
  const [enabled, setEnabled] = useState<Set<DisplayStatus>>(
    new Set(["OPEN", "IN_PROGRESS", "FIXED"]),
  );
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [assets, setAssets] = useState<Record<string, AssetState>>({});
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Bulk "mark fixed" selection (ticket ids) + in-flight progress + result.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number; regenerate: boolean } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{ fixed: number; failed: number } | null>(null);

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
    const c: Record<DisplayStatus, number> = {
      OPEN: 0,
      IN_PROGRESS: 0,
      FIXED: 0,
      APPROVED: 0,
      RESOLVED: 0,
    };
    for (const r of rows) c[displayStatusOf(r)]++;
    return c;
  }, [rows]);

  // Facet options (searchable dropdowns) with per-value counts over the whole
  // backlog — same idiom as /styles and /prod-specs. Blank values are skipped.
  const customerOptions = useMemo<FacetOption[]>(
    () => facetOptionsFrom(rows, (r) => r.customerName),
    [rows],
  );
  const businessAreaOptions = useMemo<FacetOption[]>(
    () => facetOptionsFrom(rows, (r) => r.businessArea ?? ""),
    [rows],
  );
  const outputTypeOptions = useMemo<FacetOption[]>(
    () => facetOptionsFrom(rows, (r) => r.docType, outputTypeLabel),
    [rows],
  );

  // "Select by comment": group the still-to-do tickets by their exact comment
  // text. Each option shows an excerpt + how many tickets share it; choosing it
  // selects them all. Built over ALL rows so selection spans every style
  // regardless of the other filters. Most-repeated comment first — that's the
  // highest-value bulk action. We only include OPEN/IN_PROGRESS tickets that
  // have NOT already been regenerated since rejection: a fixed or regenerated
  // output no longer needs a bulk re-fix, so it shouldn't pad the counts.
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
      .map(([value, ids]) => ({ value, label: commentExcerpt(value), count: ids.length }))
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
    const q = query.trim().toLowerCase();
    const customerSet = new Set(customers);
    const baSet = new Set(businessAreas);
    const typeSet = new Set(outputTypes);
    return rows.filter(
      (r) =>
        enabled.has(displayStatusOf(r)) &&
        (q === "" || r.searchBlob.includes(q)) &&
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

  // An active text search drills into every matching style automatically.
  const searching = query.trim() !== "";

  function toggleStatus(s: DisplayStatus) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function toggleGroup(styleId: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(styleId)) next.delete(styleId);
      else next.add(styleId);
      return next;
    });
  }

  async function loadAsset(id: string) {
    setAssets((a) => ({ ...a, [id]: "loading" }));
    try {
      const res = await fetch(`/api/admin/rejection-tickets/${id}/assets`);
      if (!res.ok) {
        setAssets((a) => ({ ...a, [id]: "error" }));
        return;
      }
      const body = (await res.json()) as TicketAssets;
      setAssets((a) => ({ ...a, [id]: { rejected: body.rejected, latest: body.latest } }));
    } catch {
      setAssets((a) => ({ ...a, [id]: "error" }));
    }
  }

  function toggleTicket(id: string) {
    const willOpen = expanded !== id;
    setExpanded(willOpen ? id : null);
    // Side effect stays outside the state updater (which StrictMode
    // double-invokes) so the asset is fetched exactly once on open.
    if (willOpen) void loadAsset(id);
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
              ? `Re-generated, but ${ph} placeholder(s) remain — the data gap isn't fixed yet.`
              : "Re-generated — check the fresh preview below.",
        }));
      }
      // A re-run replaces the asset (new job) — refresh the lazy preview too.
      if (action === "rerun" || action === "fix") void loadAsset(row.id);
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
  // existing bulk mark-fixed actions — it does NOT filter the list. We diff
  // old→new so toggling a comment off releases exactly its tickets.
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
  // may have driven it (bottom-bar "Clear", and after a bulk action completes).
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
              ? { tone: "warn", msg: `Regenerated with ${failedN} failure(s) — check the job log.` }
              : { tone: "ok", msg: "Regenerated — see the fresh times below." },
        }));
      } else {
        const fixed = body.fixed?.length ?? 0;
        const waiting = body.awaitingData ?? [];
        const orphan = body.resolvedOrphan?.length ?? 0;
        const failedN = body.failed?.length ?? 0;
        const parts: string[] = [];
        if (fixed > 0) parts.push(`${fixed} marked fixed & reviewer notified`);
        if (orphan > 0) parts.push(`${orphan} auto-resolved (output removed)`);
        if (waiting.length > 0)
          parts.push(`${waiting.length} awaiting data (${waiting.map((w) => w.outputName).join(", ")})`);
        if (failedN > 0) parts.push(`${failedN} couldn't be regenerated`);
        const tone: StyleResult["tone"] =
          failedN > 0 || (waiting.length > 0 && fixed === 0) ? "warn" : "ok";
        setStyleResult((r) => ({
          ...r,
          [styleId]: { tone, msg: parts.length ? parts.join(" · ") : "Nothing to mark fixed." },
        }));
      }
      router.refresh();
    } catch {
      setStyleResult((r) => ({ ...r, [styleId]: { tone: "err", msg: "Request failed — try again." } }));
    } finally {
      setStyleBusy((b) => ({ ...b, [styleId]: null }));
    }
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search style, PO, output, comment…"
          className="w-64 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
        />
        {DISPLAY_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleStatus(s)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              enabled.has(s) ? STATUS_PILLS[s] : "border-zinc-200 bg-white text-zinc-300"
            }`}
            title={enabled.has(s) ? `Hide ${s} tickets` : `Show ${s} tickets`}
          >
            {s.replace("_", " ")} · {counts[s]}
          </button>
        ))}
        <FacetFilter
          label="Customer"
          options={customerOptions}
          selected={customers}
          onChange={setCustomers}
          searchable
        />
        <FacetFilter
          label="Business area"
          options={businessAreaOptions}
          selected={businessAreas}
          onChange={setBusinessAreas}
          searchable
        />
        <FacetFilter
          label="Output type"
          options={outputTypeOptions}
          selected={outputTypes}
          onChange={setOutputTypes}
          searchable
        />
        {commentOptions.length > 0 ? (
          <>
            <span className="mx-0.5 h-5 w-px shrink-0 self-center bg-zinc-200" aria-hidden="true" />
            <FacetFilter
              label="Select by comment"
              options={commentOptions}
              selected={validSelectedComments}
              onChange={onSelectComments}
              searchable
            />
          </>
        ) : null}
      </div>

      {bulkSummary ? (
        <div
          className={`mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            bulkSummary.failed > 0
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          <span>
            ✓ {bulkSummary.fixed} marked fixed &amp; reviewer notified
            {bulkSummary.failed > 0 ? ` · ${bulkSummary.failed} failed (still open — try again)` : ""}.
          </span>
          <button
            type="button"
            onClick={() => setBulkSummary(null)}
            className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-800"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400">
          {rows.length === 0
            ? "No rejections yet — when a reviewer rejects an output, its ticket lands here."
            : "Nothing matches the current filters."}
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs text-zinc-400">
            {groups.length} style{groups.length === 1 ? "" : "s"} · {filtered.length} rejection
            {filtered.length === 1 ? "" : "s"}
          </p>
          <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
            {groups.map((g) => (
              <GroupSection
                key={g.styleId}
                group={g}
                open={searching || openGroups.has(g.styleId)}
                onToggle={() => toggleGroup(g.styleId)}
                expandedTicket={expanded}
                onToggleTicket={toggleTicket}
                assets={assets}
                pending={pending}
                errors={errors}
                notes={notes}
                onAct={act}
                selected={selected}
                onToggleSelect={toggleSelect}
                onSetManySelected={setManySelected}
                bulkBusy={bulk !== null}
                outputs={styleOutputs[g.styleId] ?? []}
                styleBusy={styleBusy[g.styleId] ?? null}
                styleResult={styleResult[g.styleId] ?? null}
                onStyleAct={(action) => styleAct(g.styleId, action)}
              />
            ))}
          </div>
        </>
      )}

      {selectedCount > 0 || bulk ? (
        <div className="fixed inset-x-0 bottom-5 z-20 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-full border border-zinc-300 bg-white py-2 pr-3 pl-4 shadow-lg">
            {bulk ? (
              <span className="text-sm text-zinc-700">
                {bulk.regenerate ? "Regenerating & notifying…" : "Marking fixed & notifying…"} {bulk.done}/
                {bulk.total}
              </span>
            ) : (
              <>
                <span className="text-sm font-medium text-zinc-700">
                  {selectedCount} ticket{selectedCount === 1 ? "" : "s"} selected
                </span>
                <button
                  type="button"
                  onClick={() => bulkFix(false)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                  title="Mark each selected ticket fixed and notify the reviewer — WITHOUT re-rendering (use when the outputs are already up to date)"
                >
                  ✓ Mark fixed &amp; notify
                </button>
                <button
                  type="button"
                  onClick={() => bulkFix(true)}
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
                  title="Re-render each selected output, then mark it fixed and notify the reviewer"
                >
                  ↻ Regenerate, mark fixed &amp; notify
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="text-xs text-zinc-500 underline hover:text-zinc-800"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GroupSection({
  group,
  open,
  onToggle,
  expandedTicket,
  onToggleTicket,
  assets,
  pending,
  errors,
  notes,
  onAct,
  selected,
  onToggleSelect,
  onSetManySelected,
  bulkBusy,
  outputs,
  styleBusy,
  styleResult,
  onStyleAct,
}: {
  group: StyleGroup;
  open: boolean;
  onToggle: () => void;
  expandedTicket: string | null;
  onToggleTicket: (id: string) => void;
  assets: Record<string, AssetState>;
  pending: { id: string; action: string } | null;
  errors: Record<string, string>;
  notes: Record<string, string>;
  onAct: (row: TicketRow, action: "start" | "rerun" | "fix") => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onSetManySelected: (ids: string[], on: boolean) => void;
  bulkBusy: boolean;
  outputs: StyleOutputView[];
  styleBusy: StyleAction | null;
  styleResult: StyleResult | null;
  onStyleAct: (action: StyleAction) => void;
}) {
  const selectableIds = group.tickets
    .filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS")
    .map((t) => t.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  return (
    <div className="border-b border-zinc-200 last:border-b-0">
      <div className={`flex items-stretch ${open ? "bg-zinc-50" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-50"
        aria-expanded={open}
      >
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium text-zinc-800">{group.styleName}</span>
            <span className="shrink-0 font-mono text-[10px] text-zinc-400">{group.styleNumber}</span>
          </div>
          {group.customerName ? (
            <div className="truncate text-xs text-zinc-500">{group.customerName}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {group.regeneratedCount > 0 ? (
            <span
              className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-emerald-700"
              title={`${group.regeneratedCount} output(s) re-generated since rejected — open to review`}
            >
              ↻ {group.regeneratedCount} regenerated
            </span>
          ) : null}
          {DISPLAY_STATUSES.map((s) =>
            group.counts[s] > 0 ? (
              <span
                key={s}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${STATUS_PILLS[s]}`}
                title={`${group.counts[s]} ${s.replace("_", " ")}`}
              >
                {group.counts[s]} {s.replace("_", " ").toLowerCase()}
              </span>
            ) : null,
          )}
        </div>
        <span className="hidden shrink-0 text-xs whitespace-nowrap text-zinc-400 sm:inline">
          latest {group.latestLabel}
        </span>
      </button>
        {group.prodSpecHref ? (
          <a
            href={group.prodSpecHref}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this style's Prod Spec (new tab)"
            className="flex shrink-0 items-center px-3 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path
                d="M8 4H5.5A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16h9a1.5 1.5 0 001.5-1.5V12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M12 4h4v4M16 4l-6.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        ) : null}
      </div>

      {open ? (
        <>
          <div className="border-t border-zinc-100 bg-zinc-50/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onStyleAct({ kind: "regenAll" })}
                disabled={styleBusy !== null || bulkBusy}
                title="Re-render the whole style — cover, general info and every output"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
              >
                {styleBusy?.kind === "regenAll" ? "Regenerating all…" : "↻ Regenerate all"}
              </button>
              {selectableIds.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => onStyleAct({ kind: "markFixed" })}
                    disabled={styleBusy !== null || bulkBusy}
                    title="Mark this style's rejected outputs fixed and notify the reviewer — re-renders only the ones not already refreshed since their rejection"
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {styleBusy?.kind === "markFixed" ? "Marking fixed…" : "✓ Mark fixed & notify"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onStyleAct({ kind: "regenAllFix" })}
                    disabled={styleBusy !== null || bulkBusy}
                    title="Re-render everything, then mark all rejected outputs fixed and notify the reviewer"
                    className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {styleBusy?.kind === "regenAllFix" ? "Regenerating & fixing…" : "↻ Regenerate all & mark fixed"}
                  </button>
                </>
              ) : null}
              {styleResult ? (
                <span
                  className={`text-xs ${
                    styleResult.tone === "err"
                      ? "text-red-600"
                      : styleResult.tone === "warn"
                        ? "text-amber-700"
                        : "text-emerald-700"
                  }`}
                >
                  {styleResult.msg}
                </span>
              ) : null}
            </div>

            {outputs.length > 0 ? (
              <ul className="mt-2.5 divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
                {outputs.map((o) => (
                  <li
                    key={o.variantKey}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-zinc-700">{o.name}</span>
                      {o.rejected ? (
                        <span className="shrink-0 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                          rejected
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <OutputFreshness o={o} />
                      {o.rejected && o.declared && o.ready && !o.regeneratedSinceRejection ? (
                        <button
                          type="button"
                          onClick={() => onStyleAct({ kind: "regenOutput", variantKey: o.variantKey })}
                          disabled={styleBusy !== null || bulkBusy}
                          title="Regenerate just this output"
                          className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium hover:bg-zinc-50 disabled:opacity-50"
                        >
                          {styleBusy?.kind === "regenOutput" && styleBusy.variantKey === o.variantKey
                            ? "…"
                            : "↻ Regenerate"}
                        </button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="overflow-x-auto border-t border-zinc-100 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[11px] tracking-wide text-zinc-500 uppercase">
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 cursor-pointer align-middle accent-violet-600"
                    checked={allSelected}
                    disabled={selectableIds.length === 0 || bulkBusy}
                    onChange={(e) => onSetManySelected(selectableIds, e.target.checked)}
                    title={allSelected ? "Deselect all in this style" : "Select all open tickets in this style"}
                  />
                </th>
                <th className="px-3 py-2 font-semibold">Created</th>
                <th className="px-3 py-2 font-semibold">Output</th>
                <th className="px-3 py-2 font-semibold">Customer · BA</th>
                <th className="px-3 py-2 font-semibold">PO</th>
                <th className="px-3 py-2 font-semibold">Comment</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {group.tickets.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  expanded={expandedTicket === row.id}
                  onToggle={() => onToggleTicket(row.id)}
                  asset={assets[row.id]}
                  pendingAction={pending?.id === row.id ? pending.action : null}
                  error={errors[row.id] || null}
                  note={notes[row.id] || null}
                  onAct={(action) => onAct(row, action)}
                  selected={selected.has(row.id)}
                  onToggleSelect={() => onToggleSelect(row.id)}
                  bulkBusy={bulkBusy}
                />
              ))}
            </tbody>
          </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

// Freshness badge for one output in the style overview: green when it's been
// regenerated since its rejection, amber for awaiting-data / still-rejected,
// muted for non-rejected outputs (just "generated <when>").
function OutputFreshness({ o }: { o: StyleOutputView }) {
  if (o.rejected && o.regeneratedSinceRejection) {
    return (
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-emerald-700">
        ↻ regenerated since rejection{o.lastGeneratedLabel ? ` · ${o.lastGeneratedLabel}` : ""}
      </span>
    );
  }
  if (o.rejected && !o.declared) {
    return (
      <span className="whitespace-nowrap text-[11px] text-amber-700" title="This output was removed from the prod spec — Mark fixed resolves the ticket.">
        ⚠ removed from spec — resolves on mark fixed
      </span>
    );
  }
  if (o.rejected && !o.ready) {
    return (
      <span className="whitespace-nowrap text-[11px] text-amber-700" title={o.missing.join(", ")}>
        ⚠ awaiting data
        {o.missing.length ? `: ${o.missing.slice(0, 3).join(", ")}${o.missing.length > 3 ? "…" : ""}` : ""}
      </span>
    );
  }
  if (o.rejected) {
    return <span className="whitespace-nowrap text-[11px] text-amber-700">still the rejected version</span>;
  }
  return (
    <span className="whitespace-nowrap text-[11px] text-zinc-400">
      {o.lastGeneratedLabel ? `generated ${o.lastGeneratedLabel}` : "not generated"}
    </span>
  );
}

function Row({
  row,
  expanded,
  onToggle,
  asset,
  pendingAction,
  error,
  note,
  onAct,
  selected,
  onToggleSelect,
  bulkBusy,
}: {
  row: TicketRow;
  expanded: boolean;
  onToggle: () => void;
  asset: AssetState;
  pendingAction: string | null;
  error: string | null;
  note: string | null;
  onAct: (action: "start" | "rerun" | "fix") => void;
  selected: boolean;
  onToggleSelect: () => void;
  bulkBusy: boolean;
}) {
  const actionable = row.status === "OPEN" || row.status === "IN_PROGRESS";
  const ds = displayStatusOf(row);
  const data = asset && typeof asset === "object" ? asset : null;
  const rejected = data?.rejected ?? null;
  const latest = data?.latest ?? null;
  // Surface the latest version separately only when a re-run produced a
  // different job than the one that was rejected.
  const latestDiffers = !!latest && (!rejected || latest.jobId !== rejected.jobId);
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 ${expanded ? "bg-zinc-50" : ""}`}
      >
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          {actionable ? (
            <input
              type="checkbox"
              className="h-3.5 w-3.5 cursor-pointer align-middle accent-violet-600"
              checked={selected}
              disabled={bulkBusy}
              onChange={onToggleSelect}
              aria-label="Select ticket for bulk fix"
            />
          ) : null}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-zinc-500">{row.createdAtLabel}</td>
        <td className="px-3 py-2 text-zinc-600">
          {row.outputName}
          {row.regeneratedAfterRejection && row.status !== "RESOLVED" ? (
            <span
              className="ml-2 inline-block rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-emerald-700"
              title={
                row.regeneratedAtLabel
                  ? `Re-generated ${row.regeneratedAtLabel} — newer than this rejection`
                  : "Re-generated after this rejection"
              }
            >
              ↻ regenerated
            </span>
          ) : null}
        </td>
        <td className="px-3 py-2 text-zinc-600">
          {row.customerName}
          {row.businessArea ? ` · ${row.businessArea}` : ""}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-zinc-600">{row.poNumber ?? "—"}</td>
        <td className="max-w-56 truncate px-3 py-2 text-zinc-600" title={row.comment}>
          {row.attachments.length > 0 ? (
            <span
              className="mr-1 align-middle text-[11px] text-zinc-400"
              title={`${row.attachments.length} image${row.attachments.length === 1 ? "" : "s"} attached`}
            >
              📎{row.attachments.length}
            </span>
          ) : null}
          {row.comment}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${STATUS_PILLS[ds]}`}
          >
            {ds.replace("_", " ")}
            {row.reopenedCount > 0 ? ` ×${row.reopenedCount + 1}` : ""}
          </span>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-zinc-100 last:border-b-0">
          <td colSpan={7} className="bg-zinc-50 px-4 py-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">
                  Comment{row.reopenedCount > 0 ? " (incl. re-rejections)" : ""}
                </div>
                <p className="mt-1 text-xs whitespace-pre-wrap text-zinc-700">{row.comment}</p>
                {row.attachments.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {row.attachments.map((a) => (
                      <a
                        key={a.id}
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${a.fileName} — open full size`}
                        className="block h-16 w-16 overflow-hidden rounded border border-zinc-200 bg-zinc-50 transition hover:border-zinc-400"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- admin-only attachment thumbnail, served from our API */}
                        <img src={a.url} alt={a.fileName} className="h-full w-full object-cover" />
                      </a>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-[11px] text-zinc-400">— {row.reportedBy}</p>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">Context</div>
                <p className="mt-1 text-xs text-zinc-700">
                  {row.customerName}
                  {row.businessArea ? ` · ${row.businessArea}` : ""}
                  {row.poNumber ? ` · PO ${row.poNumber}` : ""}
                </p>
                <p className="mt-1 font-mono text-[11px] break-all text-zinc-500">
                  {row.variantKey || `(no variant key — full re-run)`}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  {row.editHref ? (
                    <a
                      href={row.editHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-violet-700 underline hover:text-violet-900"
                      title="Edit the source of this output in a new tab, then come back and re-run"
                    >
                      {row.editLabel} →
                    </a>
                  ) : null}
                  <Link href={`/styles/${row.styleId}`} className="text-zinc-500 underline hover:text-zinc-800">
                    Open style →
                  </Link>
                  <Link
                    href={`/styles/${row.styleId}/review`}
                    className="text-zinc-500 underline hover:text-zinc-800"
                  >
                    Review screen →
                  </Link>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase">History</div>
                <p className="mt-1 text-xs text-zinc-700">{row.historyLabel}</p>
              </div>
            </div>

            {asset === "loading" || asset === undefined ? (
              <p className="mt-3 text-xs text-zinc-400">Loading the rejected PDF…</p>
            ) : asset === "error" ? (
              <p className="mt-3 text-xs text-red-600">Couldn&apos;t load the PDF preview.</p>
            ) : !rejected && !latest ? (
              <p className="mt-3 text-xs text-zinc-400">No generated PDF for this output right now.</p>
            ) : (
              <>
                {rejected ? (
                  <PreviewBlock
                    title="Rejected version — what the reviewer saw"
                    asset={rejected}
                    outputName={row.outputName}
                  />
                ) : (
                  <p className="mt-3 text-xs text-amber-700">
                    The originally rejected PDF is no longer stored — showing the latest version below.
                  </p>
                )}
                {latestDiffers ? (
                  <PreviewBlock title="Latest re-run" asset={latest!} outputName={row.outputName} />
                ) : null}
              </>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {row.status === "OPEN" ? (
                <button
                  type="button"
                  onClick={() => onAct("start")}
                  disabled={pendingAction !== null}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                >
                  {pendingAction === "start" ? "Starting…" : "Start work"}
                </button>
              ) : null}
              {actionable ? (
                <>
                  <button
                    type="button"
                    onClick={() => onAct("rerun")}
                    disabled={pendingAction !== null}
                    title="Regenerate this output WITHOUT notifying the reviewer"
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {pendingAction === "rerun" ? "Re-running…" : "↻ Re-run output (silent)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAct("fix")}
                    disabled={pendingAction !== null}
                    title="Final re-run + notify the reviewer that it's ready for another look"
                    className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {pendingAction === "fix" ? "Fixing…" : "✓ Mark fixed & notify reviewer"}
                  </button>
                </>
              ) : null}
              {row.status === "FIXED" ? (
                <span className="text-xs text-blue-700">
                  Awaiting re-review — the reviewer was notified. Approval resolves this ticket; another
                  rejection reopens it.
                </span>
              ) : null}
              {row.status === "RESOLVED" ? (
                row.approved ? (
                  <span className="text-xs text-emerald-700">
                    Approved — the reviewer approved this output.
                  </span>
                ) : (
                  <span className="text-xs text-zinc-500">
                    Resolved — closed without a reviewer approval (e.g. the output was removed).
                  </span>
                )
              ) : null}
              {error ? <span className="text-xs text-red-600">{error}</span> : null}
              {note ? <span className="text-xs text-emerald-700">{note}</span> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// One labelled PDF preview (header + inline iframe). Used for both the
// rejected original and, when a re-run exists, the latest version.
function PreviewBlock({
  title,
  asset,
  outputName,
}: {
  title: string;
  asset: AssetView;
  outputName: string;
}) {
  const previewUrl = `/api/admin/jobs/${asset.jobId}/preview?${asset.previewQuery}`;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50 px-3 py-1.5">
        <span className="text-[11px] font-semibold text-zinc-600">
          {title} · generated {asset.generatedAtLabel}
          <span className="font-normal text-zinc-400">
            {" · "}
            {asset.reviewStatus.toLowerCase().replace("_", " ")}
          </span>
          {asset.placeholderCount > 0 ? (
            <span className="font-normal text-amber-700"> · ⚠ {asset.placeholderCount} placeholder(s)</span>
          ) : (
            <span className="font-normal text-emerald-700"> · no placeholders</span>
          )}
        </span>
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-xs text-zinc-500 underline"
        >
          Open
        </a>
      </div>
      <iframe src={previewUrl} className="block h-72 w-full bg-white" title={`${title} — ${outputName}`} />
    </div>
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

// One-line excerpt of a (possibly long, multi-line) rejection comment, for the
// "Select by comment" dropdown option labels.
function commentExcerpt(s: string, max = 72): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
