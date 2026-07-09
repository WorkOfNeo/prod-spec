import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/auth-server";
import {
  getGenerationMinPo,
  getSupplierBatchSendEnabled,
  getSupplierSendMinPo,
  getSupplierSendMinPoExplicit,
} from "@/lib/settings/app-settings";
import { combineSupplierRecipients } from "@/lib/suppliers/recipients";
import { loadContactEmailsBySupplier } from "@/lib/suppliers/contact-emails";
import { MAX_PUSH_ATTEMPTS } from "@/lib/sharepoint/push-queued-to-supplier";
import { parseFolderMatches } from "@/lib/sharepoint/po-folder-matches";
import { PoFolderPicker } from "@/app/(admin)/styles/[id]/po-folder-picker";
import { SupplierSendSetting, SupplierSendCutoff } from "./supplier-send-setting";
import {
  SupplierPreviewButton,
  RunBatchNowButton,
  UploadNowButton,
  RetryFloatedButton,
  BackfillFoldersButton,
} from "./supplier-send-actions";
import { UploadProgress } from "./upload-progress";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approved & delivery" };

// WS2a — the delivery control tower. Shows the supplier-send queue: every
// approved output waiting to reach its supplier, grouped by supplier (with the
// resolved email) and listed in detail. Sending is gated by the master toggle
// at the top; while it's off this is a pure preview of what WOULD go out.
// The sent log + Resend open-tracking land with WS2b.
export default async function ApprovedDeliveryPage() {
  await requireAdminPage();

  const [
    enabled,
    cutoffExplicit,
    cutoffEffective,
    generationCutoff,
    pending,
    batches,
    floatedCount,
    queuedRefs,
  ] = await Promise.all([
    getSupplierBatchSendEnabled(),
    getSupplierSendMinPoExplicit(),
    getSupplierSendMinPo(),
    getGenerationMinPo(),
    db.supplierSendQueueItem.findMany({
      where: { sentAt: null },
      orderBy: { queuedAt: "desc" },
      take: 500,
    }),
    db.supplierSendBatch.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    db.supplierSendQueueItem.count({
      where: { sentAt: null, sharePointStatus: "FAILED", pushAttempts: { gte: MAX_PUSH_ATTEMPTS } },
    }),
    // Exact totals for the summary cards — independent of the 500-row display
    // cap. (Live upload-status counts moved into the UploadProgress widget.)
    db.supplierSendQueueItem.findMany({ where: { sentAt: null }, select: { styleId: true, customerId: true } }),
  ]);

  // Tonight's batch, summed up: outputs / styles / customers / business areas,
  // and where the files stand on SharePoint. BA resolves via the mirror ref
  // with the free-text fallback; blank or "–" placeholder names don't count.
  const totalOutputs = queuedRefs.length;
  const totalStyleIds = [...new Set(queuedRefs.map((q) => q.styleId))];
  const totalCustomers = new Set(queuedRefs.map((q) => q.customerId)).size;
  const baRows =
    totalStyleIds.length > 0
      ? await db.style.findMany({
          where: { id: { in: totalStyleIds } },
          select: { businessArea: true, businessAreaRef: { select: { name: true } } },
        })
      : [];
  const baNames = new Set(
    baRows
      .map((s) => (s.businessAreaRef?.name?.trim() || s.businessArea?.trim()) ?? "")
      .filter((n) => n !== "" && n !== "–" && n !== "-"),
  );

  // "Opened" tracking: collect the emailLogIds referenced by recent batches'
  // per-supplier outcomes, then find which have an "opened" Resend event.
  type PerSup = { supplierName?: string; email?: string | null; status?: string; emailLogId?: string | null; outputCount?: number; styleCount?: number };
  const batchLogIds = [
    ...new Set(
      batches.flatMap((b) => (b.perSupplier as PerSup[]).map((p) => p.emailLogId).filter((x): x is string => !!x)),
    ),
  ];
  const openedLogIds = new Set(
    batchLogIds.length > 0
      ? (
          await db.emailEvent.findMany({
            where: { emailLogId: { in: batchLogIds }, type: "opened" },
            select: { emailLogId: true },
          })
        ).map((e) => e.emailLogId as string)
      : [],
  );

  // Resolve the loose refs (styleId / customerId / supplierId) in bulk.
  const styleIds = [...new Set(pending.map((p) => p.styleId))];
  const customerIds = [...new Set(pending.map((p) => p.customerId))];
  const supplierIds = [...new Set(pending.map((p) => p.supplierId).filter((x): x is string => !!x))];

  const [styles, customers, suppliers] = await Promise.all([
    db.style.findMany({
      where: { id: { in: styleIds } },
      select: {
        id: true,
        name: true,
        poNumber: true,
        businessArea: true,
        businessAreaRef: { select: { name: true } },
      },
    }),
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
    db.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true, email: true, contactEmail: true },
    }),
  ]);

  const styleById = new Map(styles.map((s) => [s.id, s]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  // Same resolution as the nightly batch (supplier inbox → synced contacts
  // → legacy contactEmail) so the summary shows the real recipient.
  const contactEmailsBySupplier = await loadContactEmailsBySupplier(supplierIds);
  const resolveEmail = (supplierId: string | null): string | null => {
    if (!supplierId) return null;
    const s = supplierById.get(supplierId);
    return combineSupplierRecipients(s, contactEmailsBySupplier.get(supplierId) ?? []).to;
  };

  // Group by supplier for the summary.
  type Group = { supplierId: string | null; name: string; email: string | null; count: number };
  const groups = new Map<string, Group>();
  for (const item of pending) {
    const key = item.supplierId ?? "__none__";
    const g = groups.get(key);
    if (g) g.count += 1;
    else
      groups.set(key, {
        supplierId: item.supplierId,
        name: item.supplierId ? (supplierById.get(item.supplierId)?.name ?? "Unknown supplier") : "— no supplier linked",
        email: resolveEmail(item.supplierId),
        count: 1,
      });
  }
  const groupList = [...groups.values()].sort((a, b) => b.count - a.count);

  const spPill = (status: string) => {
    const map: Record<string, string> = {
      UPLOADED: "border-emerald-200 bg-emerald-50 text-emerald-700",
      PENDING: "border-amber-200 bg-amber-50 text-amber-700",
      FAILED: "border-red-200 bg-red-50 text-red-700",
      SKIPPED: "border-zinc-200 bg-zinc-50 text-zinc-500",
      NO_FOLDER: "border-orange-200 bg-orange-50 text-orange-700",
      AMBIGUOUS: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
    };
    return map[status] ?? map.PENDING;
  };
  // Human labels for the folder-shaped flags (the raw enum reads badly).
  const spLabel = (status: string) =>
    status === "NO_FOLDER" ? "no PO folder" : status === "AMBIGUOUS" ? "multiple PO folders" : status.toLowerCase();

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Approved &amp; delivery</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Approved outputs waiting to reach their supplier — what goes out in tonight&rsquo;s digest,
        and where each file stands on SharePoint.
      </p>

      {/* Tonight's batch, summed up. */}
      <div className="mt-6 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Outputs tonight", value: totalOutputs },
          { label: "Styles", value: totalStyleIds.length },
          { label: "Customers", value: totalCustomers },
          { label: "Business areas", value: baNames.size },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-zinc-200 px-4 py-3">
            <div className="text-2xl font-semibold tabular-nums text-zinc-900">{c.value}</div>
            <div className="mt-0.5 text-xs uppercase tracking-wide text-zinc-500">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Live SharePoint upload progress — polls while the cron sweeps drain
          the queue (segmented bar + rate + ETA). Replaces the static chip row;
          the server-rendered tables refresh automatically when it settles. */}
      <div className="mt-3 max-w-4xl">
        <UploadProgress enabled={enabled} />
      </div>

      <div className="mt-6 grid max-w-5xl gap-4 lg:grid-cols-2">
        <SupplierSendSetting initialEnabled={enabled} />
        <SupplierSendCutoff
          initialExplicit={cutoffExplicit}
          effective={cutoffEffective}
          generation={generationCutoff}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <RunBatchNowButton enabled={enabled} />
        <UploadNowButton enabled={enabled} />
        <RetryFloatedButton floatedCount={floatedCount} />
      </div>

      {/* One-off maintenance: re-push already-delivered styles into the new
          folder layout ("<PO> - <customer> - <supplier>" folder → "APPROVED
          LAYOUTS" subfolder). The layout change is forward-only, so styles
          already pushed under an older naming need this once to keep their whole
          set in one place. */}
      <div className="mt-6 max-w-3xl rounded-lg border border-zinc-200 bg-zinc-50/60 px-4 py-3">
        <div className="text-sm font-medium text-zinc-800">Supplier folder naming</div>
        <p className="mt-0.5 mb-2 text-xs text-zinc-500">
          Approved layouts land in{" "}
          <span className="font-mono text-[11px] text-zinc-600">
            PO - Customer - Supplier
          </span>{" "}
          →{" "}
          <span className="font-mono text-[11px] text-zinc-600">APPROVED LAYOUTS</span>, shared across
          styles on the same PO. Run this once to move styles that were already pushed under an older
          naming into the new folders. Old folders are left in place — use the cleanup script
          (<span className="font-mono text-[11px]">npm run cleanup-legacy-supplier-folders</span>) to
          remove them.
        </p>
        <BackfillFoldersButton />
      </div>

      {/* Per-supplier summary — who gets what tonight, and to which email. */}
      <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-700">By supplier</h2>
      <div className="overflow-hidden rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Outputs queued</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {groupList.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-zinc-500">
                  Nothing queued yet. Outputs appear here as soon as they&rsquo;re approved.
                </td>
              </tr>
            ) : (
              groupList.map((g) => (
                <tr key={g.supplierId ?? "none"} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-medium text-zinc-800">{g.name}</td>
                  <td className="px-4 py-2">
                    {g.email ? (
                      <span className="font-mono text-xs text-zinc-600">{g.email}</span>
                    ) : (
                      <span className="inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                        no email on file
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-zinc-700">{g.count}</td>
                  <td className="px-4 py-2 text-right">
                    <SupplierPreviewButton supplierId={g.supplierId} supplierName={g.name} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Detail — every queued output. */}
      <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-700">Queued outputs</h2>
      <div className="overflow-hidden rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Customer / BA</th>
              <th className="px-4 py-2">Style</th>
              <th className="px-4 py-2">Output</th>
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">SharePoint</th>
              <th className="px-4 py-2">Queued</th>
            </tr>
          </thead>
          <tbody>
            {pending.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                  No approved outputs are waiting.
                </td>
              </tr>
            ) : (
              pending.map((item) => {
                const style = styleById.get(item.styleId);
                const customer = customerById.get(item.customerId);
                const ba = style?.businessAreaRef?.name ?? style?.businessArea ?? "—";
                return (
                  <tr key={item.id} className="border-t border-zinc-100">
                    <td className="px-4 py-2">
                      <div className="font-medium text-zinc-800">{customer?.name ?? "—"}</div>
                      <div className="text-xs text-zinc-500">{ba}</div>
                    </td>
                    <td className="px-4 py-2">
                      <Link href={`/styles/${item.styleId}`} className="text-zinc-700 underline">
                        {style?.name ?? item.styleId}
                      </Link>
                      {style?.poNumber ? (
                        <div className="font-mono text-[11px] text-zinc-400">{style.poNumber}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-zinc-700">{item.displayName ?? item.docType}</div>
                      <div className="font-mono text-[11px] text-zinc-400">{item.variantKey}</div>
                    </td>
                    <td className="px-4 py-2 text-zinc-600">
                      {item.supplierId ? supplierById.get(item.supplierId)?.name ?? "—" : (
                        <span className="text-red-500">none</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {(() => {
                        const label =
                          item.sharePointStatus === "FAILED" && item.pushAttempts >= MAX_PUSH_ATTEMPTS
                            ? `failed · gave up (${item.pushAttempts}×)`
                            : item.sharePointStatus === "FAILED" && item.pushAttempts > 0
                              ? `failed (${item.pushAttempts}×)`
                              : spLabel(item.sharePointStatus);
                        const pill = (
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${spPill(item.sharePointStatus)}`}
                          >
                            {label}
                          </span>
                        );
                        // Deep-link the pill to the "APPROVED LAYOUTS" folder the
                        // file landed in (fall back to the file URL).
                        const folderHref = item.sharePointFolderUrl ?? item.sharePointUrl;
                        return folderHref ? (
                          <a href={folderHref} target="_blank" rel="noopener noreferrer" title="Open the supplier's SharePoint folder">
                            {pill}
                          </a>
                        ) : (
                          pill
                        );
                      })()}
                      {item.sharePointStatus === "UPLOADED" ? (
                        <div className="mt-0.5 text-[10px] text-zinc-400">
                          {item.sharePointVerifiedAt
                            ? `verified ${item.sharePointVerifiedAt.toISOString().slice(0, 10)}`
                            : "not yet verified"}
                        </div>
                      ) : item.sharePointStatus === "AMBIGUOUS" ? (
                        <div className="mt-1 text-[10px] text-fuchsia-700">
                          <div className="mb-0.5">pick where to send:</div>
                          <PoFolderPicker
                            styleId={item.styleId}
                            matches={parseFolderMatches(item.sharePointFolderMatches)}
                            compact
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {item.queuedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Sent / history — recent nightly (or manual) batch runs. */}
      <h2 className="mt-8 mb-2 text-sm font-semibold text-zinc-700">Recent sends</h2>
      <div className="overflow-hidden rounded-lg border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2">Result</th>
              <th className="px-4 py-2">Suppliers</th>
              <th className="px-4 py-2">Per-supplier</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  No batch has run yet. Use “Run batch now” above, or wait for the midnight cron.
                </td>
              </tr>
            ) : (
              batches.map((b) => {
                const per = (b.perSupplier as PerSup[]) ?? [];
                return (
                  <tr key={b.id} className="border-t border-zinc-100 align-top">
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {b.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="px-4 py-2 text-zinc-600">{b.source}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                        {b.status}
                      </span>
                      <div className="mt-0.5 text-[11px] text-zinc-400">
                        {b.sentCount}/{b.outputCount} output(s) sent
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular-nums text-zinc-700">{b.supplierCount}</td>
                    <td className="px-4 py-2">
                      {per.length === 0 ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {per.map((p, i) => (
                            <li key={i} className="text-[11px] text-zinc-600">
                              <span className="font-medium text-zinc-700">{p.supplierName ?? "—"}</span>{" "}
                              <span className="text-zinc-400">·</span> {p.status}
                              {p.status === "SENT" && p.emailLogId ? (
                                openedLogIds.has(p.emailLogId) ? (
                                  <span className="ml-1 rounded-full bg-emerald-50 px-1.5 text-emerald-700">opened</span>
                                ) : (
                                  <span className="ml-1 text-zinc-400">not yet opened</span>
                                )
                              ) : null}
                              {p.status === "NO_EMAIL" ? <span className="ml-1 text-red-500">(no email)</span> : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-2xl text-xs text-zinc-400">
        Missing supplier emails resolve once the Monday supplier sync is updated. Open-tracking needs
        the Resend webhook pointed at <span className="font-mono">/api/webhooks/resend</span>.
      </p>
    </div>
  );
}
