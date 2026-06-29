import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { AssetActions } from "./asset-actions";
import { OutputBulkActions } from "./output-bulk-actions";
import { SupplierPushActions } from "./supplier-push-actions";
import { ReviewClaim } from "./claim-review";
import { ReviewLeaveGuard } from "./leave-guard";
import { ReviewCartonCustomize } from "./review-carton-customize";
import { LogStyleView } from "@/components/log-style-view";
import { groupByDocType, DocTypeAccordion } from "../doc-type-groups";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { getVariant } from "@/lib/pdf/template-registry";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { baseVariantKey } from "@/lib/tickets/orphan";
import {
  getCurrentOutputsForStyle,
  rollupOutputSlots,
  outputAnchor,
  type CurrentOutput,
  type OutputState,
} from "@/lib/outputs/current-outputs";

export const dynamic = "force-dynamic";

// The review screen now reads the STYLE's current outputs — the latest asset
// per (variantKey) across all jobs, lined up against the declared output set —
// so outputs generated in different runs roll up here together. Decisions stay
// per output; the bulk shortcuts loop the per-output endpoints.

const NOT_READY_LABEL: Record<OutputState, string> = {
  AWAITING_DATA: "Awaiting data",
  READY_TO_GENERATE: "Ready to generate",
  GENERATING: "Generating…",
  TO_REVIEW: "To review",
  BLOCKED: "Blocked",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const style = await db.style.findUnique({ where: { id }, select: { name: true } });
  return { title: style ? `Review ${style.name}` : "Review" };
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, role } = await getSessionWithRole();
  // Push-to-supplier is an ADMIN-only action (no REVIEWER) — distinct from the
  // approve/reject gate (canReview). The endpoints enforce the same.
  const canPush = isAdmin(role);

  const style = await db.style.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      poNumber: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
    },
  });
  if (!style) notFound();

  const [outputs, docTypeLabels] = await Promise.all([
    getCurrentOutputsForStyle(id),
    loadDocTypeLabels(),
  ]);
  const rollup = rollupOutputSlots(outputs);

  const businessArea = style.businessAreaRef?.name ?? style.businessArea ?? null;
  const styleContext = [
    style.name,
    style.customer.name,
    businessArea,
    style.poNumber ? `PO ${style.poNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Reviewable = generated and not currently regenerating.
  const reviewable = outputs.filter((o) => o.jobAssetId != null && o.state !== "GENERATING");
  const notReady = outputs.filter((o) => o.jobAssetId == null || o.state === "GENERATING");
  const pendingReviewable = reviewable.filter((o) => o.reviewStatus === "PENDING_REVIEW");
  const approveAssetIds = pendingReviewable
    .filter((o) => o.placeholderCount === 0 && o.jobAssetId)
    .map((o) => o.jobAssetId as string);
  const rejectAssetIds = pendingReviewable.map((o) => o.jobAssetId as string);
  const blockedCount = pendingReviewable.filter((o) => o.placeholderCount > 0).length;
  // Admin push-to-supplier targets APPROVED, print-safe outputs only.
  const pushableCount = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" && o.placeholderCount === 0 && o.jobAssetId,
  ).length;

  const notGeneratedCount = rollup.awaitingData + rollup.readyToGenerate;
  // Generation coverage — how many of the declared output slots have been
  // produced (e.g. 2/3 · 67%). rollupOutputSlots collapses multi-document
  // outputs to one slot, so a carton X-of-Y counts once, not per sticker.
  const genPct = rollup.total > 0 ? Math.round((rollup.generated / rollup.total) * 100) : 0;
  const tally = [
    rollup.approved > 0 ? `${rollup.approved} approved` : null,
    rollup.rejected > 0 ? `${rollup.rejected} rejected` : null,
    rollup.toReview > 0 ? `${rollup.toReview} to review` : null,
    rollup.blocked > 0 ? `${rollup.blocked} blocked` : null,
    rollup.generating > 0 ? `${rollup.generating} generating` : null,
    notGeneratedCount > 0 ? `${notGeneratedCount} not generated` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Test-phase follow-through (claim popup/chip + leave guard) — bound to the
  // newest still-pending generation job for this style, with style-level counts.
  const followThrough = reviewFollowThroughEnabled();
  const pendingJob = followThrough
    ? await db.job.findFirst({
        where: { styleId: id, status: "AWAITING_REVIEW" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          reviewClaimedById: true,
          reviewClaimedAt: true,
          reviewClaimedBy: { select: { name: true, email: true } },
        },
      })
    : null;
  const decided = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" || o.reviewStatus === "REJECTED",
  ).length;
  const pending = pendingReviewable.length;
  const claimedByMe =
    pendingJob?.reviewClaimedById != null && pendingJob.reviewClaimedById === session?.user.id;

  if (outputs.length === 0) {
    return (
      <div className="px-8 py-8">
        <LogStyleView styleId={id} surface="REVIEW" />
        <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">No outputs to review</h1>
        <p className="mt-1 text-sm text-zinc-500">
          This style has no enabled outputs on its prod spec yet.
        </p>
      </div>
    );
  }

  // Outputs the admin marked FIXED on the rejection log ("ready for re-review").
  // These must stay in the MAIN view so the reviewer can act on them even if the
  // latest asset is an older-generation rejection that wasn't re-rendered — the
  // "locate on /review when marked fixed" guard (the rejection-log History split
  // relies on this so a fixed thread is always findable here).
  const fixedTicketBases = new Set(
    (
      await db.rejectionTicket.findMany({
        where: { styleId: id, status: "FIXED" },
        select: { variantKey: true },
      })
    ).map((t) => baseVariantKey(t.variantKey)),
  );
  const hasFixedTicket = (o: CurrentOutput) =>
    fixedTicketBases.has(baseVariantKey(o.variantKey));

  // History = outputs decided (approved/rejected) in an EARLIER run. They stay
  // fully visible — same card, same actions — but collapse into the "Earlier
  // generations" accordion so the main view shows only the current run. Going
  // through the same style again and again no longer drowns in prior decisions.
  // Anything still pending — or marked fixed and awaiting re-review — is NEVER
  // history, even if it came from an older job.
  const isSettled = (o: CurrentOutput) =>
    o.reviewStatus === "APPROVED" || o.reviewStatus === "REJECTED";
  const isHistoryOutput = (o: CurrentOutput) =>
    isSettled(o) && !o.fromLatestGeneration && !hasFixedTicket(o);
  const history = reviewable.filter(isHistoryOutput);
  const current = reviewable.filter((o) => !isHistoryOutput(o));

  const groups = groupByDocType<CurrentOutput>(current, docTypeLabels);
  const placeholderOutputs = reviewable.filter((o) => o.placeholderCount > 0);

  return (
    <div className="px-8 py-8">
      <LogStyleView styleId={id} surface="REVIEW" />
      {followThrough ? (
        // Per-style key now — leaving with some-decided/some-pending intercepts.
        <ReviewLeaveGuard
          jobId={style.id}
          decided={decided}
          pending={pending}
          claimedByMe={claimedByMe}
          styleContext={styleContext}
        />
      ) : null}
      <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back to style</Link>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review · {style.name}</h1>
          <p className="text-sm text-zinc-500">
            {style.customer.name}
            {businessArea ? <> · {businessArea}</> : null}
            {style.poNumber ? <> · PO {style.poNumber}</> : null}
            {" · "}
            {rollup.total} output{rollup.total === 1 ? "" : "s"}
            {tally ? <> — {tally}</> : null}
          </p>
          {/* Generation coverage — at-a-glance "is this style fully generated?" */}
          <div className="mt-2 flex items-center gap-2">
            <div
              className="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-100"
              role="progressbar"
              aria-valuenow={genPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Outputs generated"
            >
              <div
                className={`h-full rounded-full ${rollup.complete ? "bg-emerald-500" : "bg-amber-500"}`}
                style={{ width: `${genPct}%` }}
              />
            </div>
            <span className="text-xs font-medium tabular-nums text-zinc-600">
              {rollup.generated}/{rollup.total} generated · {genPct}%
            </span>
            {!rollup.complete && notGeneratedCount > 0 ? (
              <span className="text-xs text-amber-700">{notGeneratedCount} not generated</span>
            ) : null}
          </div>
          {followThrough && pendingJob ? (
            <ReviewClaim
              jobId={pendingJob.id}
              pendingCount={pending}
              claimedByName={
                pendingJob.reviewClaimedBy
                  ? pendingJob.reviewClaimedBy.name || pendingJob.reviewClaimedBy.email
                  : null
              }
              claimedByMe={claimedByMe}
              claimedAtIso={pendingJob.reviewClaimedAt?.toISOString() ?? null}
              styleContext={styleContext}
            />
          ) : null}
        </div>
        <div className="flex items-end gap-3">
          {canPush ? (
            <SupplierPushActions styleId={style.id} pushableCount={pushableCount} />
          ) : null}
          <OutputBulkActions
            styleId={style.id}
            styleContext={styleContext}
            approveAssetIds={approveAssetIds}
            rejectAssetIds={rejectAssetIds}
            blockedCount={blockedCount}
          />
        </div>
      </div>

      {placeholderOutputs.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="text-sm font-semibold text-red-800">
            {placeholderOutputs.length} output
            {placeholderOutputs.length > 1 ? "s contain" : " contains"} placeholder artifacts —
            approval is blocked
          </div>
          <p className="mt-1 text-xs text-red-700">
            Dashed “missing artwork” tiles or “No carton EAN” boxes are review-safe but must never
            ship to print. Fix the gaps and re-run the output.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-red-800">
            {placeholderOutputs.map((o) => (
              <li key={o.variantKey}>
                · {o.name} — {o.placeholderCount} placeholder{o.placeholderCount > 1 ? "s" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Generated outputs, grouped per document type. */}
      <div className="mt-6 flex flex-col gap-3">
        {groups.map((group) => {
          const gApproved = group.items.filter((o) => o.reviewStatus === "APPROVED").length;
          const gRejected = group.items.filter((o) => o.reviewStatus === "REJECTED").length;
          const gPending = group.items.length - gApproved - gRejected;
          const hint = [
            gApproved > 0 ? `${gApproved} approved` : null,
            gRejected > 0 ? `${gRejected} rejected` : null,
            gPending > 0 ? `${gPending} pending` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <DocTypeAccordion
              key={group.docType}
              label={group.label}
              count={group.items.length}
              rightHint={hint}
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {group.items.map((o) => (
                  <OutputReviewCard
                    key={o.variantKey}
                    o={o}
                    styleId={style.id}
                    styleContext={styleContext}
                    canPush={canPush}
                  />
                ))}
              </div>
            </DocTypeAccordion>
          );
        })}
      </div>

      {history.length > 0 ? (
        <div className="mt-3">
          <DocTypeAccordion
            label="Earlier generations"
            count={history.length}
            rightHint="decided in a previous run — kept for reference"
            defaultOpen={false}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {history.map((o) => (
                <OutputReviewCard
                  key={o.variantKey}
                  o={o}
                  styleId={style.id}
                  styleContext={styleContext}
                  canPush={canPush}
                />
              ))}
            </div>
          </DocTypeAccordion>
        </div>
      ) : null}

      {notReady.length > 0 ? (
        <div className="mt-3">
          <DocTypeAccordion
            label="Not generated yet"
            count={notReady.length}
            rightHint="can't generate (missing fields), queued, or generating"
            // Open by default when there's nothing reviewable, so a style whose
            // outputs were all skipped for missing fields shows WHY up front.
            defaultOpen={reviewable.length === 0}
          >
            <ul className="divide-y divide-zinc-100 text-sm">
              {notReady.map((o) => {
                // Required fields missing ⇒ generation was deliberately skipped.
                // Say so plainly and name the fields — that's the actionable bit.
                const missing = o.state === "AWAITING_DATA" && o.missing.length > 0;
                return (
                  <li key={o.variantKey} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-medium text-zinc-700">{o.name}</span>
                    <span className="flex items-center gap-2 text-xs text-zinc-500">
                      {missing ? (
                        <span className="text-amber-700">
                          missing: {o.missing.map((m) => m.label).join(", ")}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${missing ? "bg-amber-100 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}
                      >
                        {missing ? "Can't generate" : NOT_READY_LABEL[o.state]}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </DocTypeAccordion>
        </div>
      ) : null}
    </div>
  );
}

// One reviewable output card — preview + identity header + decision footer.
// Shared by the current-generation groups and the "Earlier generations"
// history accordion so a prior-run decision renders identically (and stays
// re-reviewable) without duplicating ~120 lines of markup.
function OutputReviewCard({
  o,
  styleId,
  styleContext,
  canPush,
}: {
  o: CurrentOutput;
  styleId: string;
  styleContext: string;
  canPush: boolean;
}) {
  const previewUrl = `/api/admin/jobs/${o.jobId}/preview?variantKey=${encodeURIComponent(o.variantKey)}`;
  // Carton-capable outputs (numbering / multi-style) get an in-review Customize
  // action — regenerate the set in place and re-review it. Capability + print
  // dims come from the layout variant; the registry is already loaded by
  // getCurrentOutputsForStyle, so getVariant resolves here.
  const baseKey = o.variantKey.split("#")[0];
  const variant = getVariant(baseKey);
  const cartonCapable = Boolean(variant && (variant.cartonNumbering || variant.multipleStyles));
  const dotClass =
    o.reviewStatus === "APPROVED"
      ? "bg-emerald-500"
      : o.reviewStatus === "REJECTED"
        ? "bg-red-500"
        : "bg-zinc-300";
  return (
    <div
      id={outputAnchor(o.variantKey)}
      className="flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white scroll-mt-4"
    >
      {/* Header — identity only: status dot + name + file + capability chips,
          with Open as a quiet corner icon. Every decision lives in the footer
          bar below the preview, so nothing competes with the title for width. */}
      <div className="flex items-start gap-2.5 border-b border-zinc-100 bg-zinc-50 px-3 py-2.5">
        <span
          aria-hidden="true"
          className={`mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`}
        />
        <div className="min-w-0 flex-1">
          <div
            className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-800"
            title={o.name}
          >
            {o.name}
          </div>
          {o.fileName ? (
            <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{o.fileName}</div>
          ) : null}
          {variant && (variant.cartonNumbering || variant.multipleStyles) ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {variant.cartonNumbering ? (
                <span
                  title="Carton numbering — print a numbered set (X of Y)"
                  className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700"
                >
                  X of Y
                </span>
              ) : null}
              {variant.multipleStyles ? (
                <span
                  title="Multiple styles — place other same-PO styles on the box"
                  className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-indigo-700"
                >
                  Multi-style
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the full PDF in a new tab"
          aria-label="Open the full PDF in a new tab"
          className="flex-shrink-0 rounded-md p-1 text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-600"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </a>
      </div>
      {o.reviewStatus === "REJECTED" && o.rejectReason ? (
        <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">
          <span className="font-semibold">Rejected:</span> {o.rejectReason}{" "}
          <Link href="/settings/rejection-log" className="text-red-700 underline">
            view ticket →
          </Link>
        </div>
      ) : null}
      {o.placeholderCount > 0 ? (
        <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ {o.placeholderCount} placeholder{o.placeholderCount === 1 ? "" : "s"} in this PDF —
          approval is blocked until the data is fixed and the output re-run.
        </div>
      ) : null}
      <iframe src={previewUrl} className="block h-[600px] w-full bg-white" title={o.name} />
      {/* Footer action bar — Open is in the header; decisions, status and
          Customize all live here on their own rows. */}
      <AssetActions
        assetId={o.jobAssetId as string}
        styleId={styleId}
        reviewStatus={o.reviewStatus ?? "PENDING_REVIEW"}
        rejectReason={o.rejectReason}
        placeholderCount={o.placeholderCount}
        outputTitle={o.name}
        styleContext={styleContext}
        canPush={canPush}
        customizeSlot={
          cartonCapable && variant ? (
            <ReviewCartonCustomize
              styleId={styleId}
              variantKey={baseKey}
              name={o.name}
              widthMm={variant.defaultWidthMm}
              heightMm={variant.defaultHeightMm}
              cartonNumbering={variant.cartonNumbering ?? false}
              multipleStyles={variant.multipleStyles ?? false}
            />
          ) : null
        }
      />
    </div>
  );
}
