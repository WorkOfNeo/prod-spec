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
import { UndoIgnoreButton } from "./undo-ignore-button";
import { RunOutputButton } from "../run-output-button";
import { LogStyleView } from "@/components/log-style-view";
import { groupByDocType, DocTypeAccordion } from "../doc-type-groups";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { getVariant } from "@/lib/pdf/template-registry";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import {
  getCurrentOutputsForStyle,
  rollupOutputSlots,
  outputAnchor,
  type CurrentOutput,
} from "@/lib/outputs/current-outputs";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { mondayItemUrl } from "@/lib/monday/url";
import { styleReadinessNotice } from "@/lib/styles/readiness-notice";
import {
  OutputReadinessNotice,
  type ReadinessHrefs,
} from "@/components/output-readiness-notice";

export const dynamic = "force-dynamic";

// The review screen now reads the STYLE's current outputs — the latest asset
// per (variantKey) across all jobs, lined up against the declared output set —
// so outputs generated in different runs roll up here together. Decisions stay
// per output; the bulk shortcuts loop the per-output endpoints.

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
      poFileName: true,
      eanStatus: true,
      eanAttempts: true,
      mondayBoardId: true,
      mondayItemId: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
      supplier: { select: { sharepointUrl: true } },
      prodSpec: { select: { id: true, outputs: true } },
    },
  });
  if (!style) notFound();

  const [outputs, docTypeLabels] = await Promise.all([
    getCurrentOutputsForStyle(id),
    loadDocTypeLabels(),
  ]);
  const rollup = rollupOutputSlots(outputs);

  // The shared, role-aware Output Readiness Notice — one model that folds the
  // whole pipeline (SharePoint → PO → EANs → fields → generation → review) into
  // a headline pill + step ladder. Supersedes the ad-hoc progress bar, the
  // placeholder-blocked alert, and the "Not generated yet" accordion below.
  const prodSpecOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []);
  const viewerRole = isAdmin(role) ? "ADMIN" : "REVIEWER";
  const notice = styleReadinessNotice(
    {
      eanStatus: style.eanStatus,
      eanAttempts: style.eanAttempts,
      poNumber: style.poNumber,
      poFileName: style.poFileName,
      hasProdSpec: style.prodSpec != null,
      prodSpecHasOutputs: prodSpecOutputs.some((o) => o.enabled !== false),
      currentOutputs: outputs,
    },
    viewerRole,
  );
  const prodSpecHref = style.prodSpec ? `/prod-specs/${style.prodSpec.id}` : undefined;
  const mondayHref = mondayItemUrl(style.mondayBoardId, style.mondayItemId);
  const readinessHrefs: ReadinessHrefs = {
    openPoEans: "/po-eans",
    ...(mondayHref ? { openMonday: mondayHref } : {}),
    ...(prodSpecHref
      ? { openProdSpec: prodSpecHref, setBusinessArea: prodSpecHref, pinFieldInSpec: prodSpecHref }
      : {}),
    ...(style.supplier?.sharepointUrl
      ? { openSuppliersDrive: style.supplier.sharepointUrl }
      : {}),
  };

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
  // Excluded = deliberately skipped by a doc-type keyword rule (decided, not
  // pending) — listed separately so they don't read as "still waiting". The
  // readiness notice (PR #154) covers the missing-fields/queued/generating
  // outputs, so there's no separate "not generated yet" list here anymore.
  const excludedOutputs = outputs.filter((o) => o.state === "EXCLUDED");
  // Outputs that COULD NOT be generated because required fields are blank on
  // Monday. Readiness-gating (PR #152) means these never produced a (blank)
  // PDF, so there's no tile to show — instead of silently hiding them, we show
  // a message in the output area naming the fields to fill in on Monday.
  const missingFieldOutputs = outputs.filter(
    (o) => o.state === "AWAITING_DATA" && o.missing.length > 0,
  );
  const pendingReviewable = reviewable.filter((o) => o.reviewStatus === "PENDING_REVIEW");
  const approveAssetIds = pendingReviewable
    .filter((o) => o.placeholderCount === 0 && o.jobAssetId)
    .map((o) => o.jobAssetId as string);
  const rejectAssetIds = pendingReviewable.map((o) => o.jobAssetId as string);
  // Bundle framing (cover / general info) regenerates with every run — it
  // can't be ignored per style, so it's excluded from "Ignore all" and its
  // card hides the Ignore button.
  const ignorableOutput = (o: CurrentOutput) => {
    const b = baseVariantKey(o.variantKey);
    return b !== COVER_VARIANT_KEY && b !== GENERAL_INFO_VARIANT_KEY;
  };
  const ignoreAssetIds = pendingReviewable
    .filter(ignorableOutput)
    .map((o) => o.jobAssetId as string);
  const blockedCount = pendingReviewable.filter((o) => o.placeholderCount > 0).length;
  // Admin push-to-supplier targets APPROVED, print-safe outputs only.
  const pushableCount = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" && o.placeholderCount === 0 && o.jobAssetId,
  ).length;

  const notGeneratedCount = rollup.awaitingData + rollup.readyToGenerate;
  const tally = [
    rollup.approved > 0 ? `${rollup.approved} approved` : null,
    rollup.rejected > 0 ? `${rollup.rejected} rejected` : null,
    rollup.toReview > 0 ? `${rollup.toReview} to review` : null,
    rollup.blocked > 0 ? `${rollup.blocked} blocked` : null,
    rollup.generating > 0 ? `${rollup.generating} generating` : null,
    notGeneratedCount > 0 ? `${notGeneratedCount} not generated` : null,
    rollup.excluded > 0 ? `${rollup.excluded} excluded` : null,
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

  // History = REJECTED outputs from an EARLIER run only. They stay fully
  // visible — same card — but collapse into the "Earlier generations" accordion
  // so the main view isn't cluttered by stale rejections.
  //
  // APPROVED outputs are NEVER history: with durable approval a full re-run
  // preserves them instead of regenerating (so their latest asset is from an
  // earlier job — fromLatestGeneration is false), but they are the CURRENT
  // approved state and must stay in the main view so the reviewer can always
  // see them (read-only badge, no decide buttons). Before, they vanished into
  // the accordion the moment the rest of the style was re-run.
  //
  // Anything still pending — or marked fixed and awaiting re-review — is also
  // never history, even from an older job.
  const isHistoryOutput = (o: CurrentOutput) =>
    o.reviewStatus === "REJECTED" && !o.fromLatestGeneration && !hasFixedTicket(o);
  const history = reviewable.filter(isHistoryOutput);
  const current = reviewable.filter((o) => !isHistoryOutput(o));

  const groups = groupByDocType<CurrentOutput>(current, docTypeLabels);

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
            ignoreAssetIds={ignoreAssetIds}
            blockedCount={blockedCount}
          />
        </div>
      </div>

      {/* The shared Output Readiness Notice — folds the old progress bar, the
          placeholder-blocked alert, and the "Not generated yet" accordion into
          one role-aware ladder (source/PO/SharePoint → spec → fields →
          generation → review). The blocked step + reviewer "don't approve"
          banner preserve the old red alert's intent. */}
      <div className="mt-4">
        <OutputReadinessNotice notice={notice} role={viewerRole} hrefs={readinessHrefs} />
      </div>

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

      {missingFieldOutputs.length > 0 ? (
        <div className="mt-3">
          <DocTypeAccordion
            label="Missing fields — could not be generated"
            count={missingFieldOutputs.length}
            rightHint="fill the fields on Monday, then they generate automatically"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {missingFieldOutputs.map((o) => (
                <div
                  key={o.variantKey}
                  className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4"
                >
                  <div className="text-sm font-semibold text-amber-900">{o.name}</div>
                  <p className="mt-1 text-xs leading-relaxed text-amber-800">
                    Missing fields, output could not be generated. Please fill these in{" "}
                    {mondayHref ? (
                      <a
                        href={mondayHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium underline"
                      >
                        Monday
                      </a>
                    ) : (
                      "Monday"
                    )}
                    :
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {o.missing.map((m) => (
                      <span
                        key={m.field}
                        className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800"
                      >
                        {m.label}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </DocTypeAccordion>
        </div>
      ) : null}

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

      {excludedOutputs.length > 0 ? (
        <div className="mt-3">
          <DocTypeAccordion
            label="Excluded / ignored — won't be generated"
            count={excludedOutputs.length}
            rightHint="skipped by a doc-type rule, or ignored for this style"
            defaultOpen={false}
          >
            <ul className="divide-y divide-zinc-100 text-sm">
              {excludedOutputs.map((o) => (
                <li key={o.variantKey} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-medium text-zinc-700">{o.name}</span>
                  <span className="flex items-center gap-2 text-xs">
                    {o.exclusionReason ? (
                      <span className={o.ignored ? "text-zinc-500" : "text-amber-700"}>
                        {o.exclusionReason}
                      </span>
                    ) : null}
                    {o.ignored ? (
                      <>
                        <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-600">
                          ⊘ Ignored
                        </span>
                        <UndoIgnoreButton
                          styleId={style.id}
                          variantKey={o.variantKey.split("#")[0]}
                        />
                      </>
                    ) : (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                        Excluded
                      </span>
                    )}
                  </span>
                </li>
              ))}
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
  // Framing pages (cover / general info) regenerate every run — not ignorable.
  const canIgnore = baseKey !== COVER_VARIANT_KEY && baseKey !== GENERAL_INFO_VARIANT_KEY;
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
        canIgnore={canIgnore}
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
      {/* Single-output re-run (WS8) — change the data (wash-care, care label)
          then re-run just this output without touching the rest of the review.
          A scoped re-run regenerates even an approved output (explicit intent),
          so it comes back for a fresh decision. */}
      <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3 py-2">
        <span className="text-[11px] text-zinc-400">Changed the data? Re-run just this output.</span>
        <RunOutputButton
          styleId={styleId}
          variantKey={baseKey}
          ready={o.missing.length === 0}
          missingLabels={o.missing.map((m) => m.label)}
          label="Re-run this output"
        />
      </div>
    </div>
  );
}
