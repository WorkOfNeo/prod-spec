import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import {
  getCoverPageInfoMd,
  getStoredTrimConceptCopy,
  getTrimsOnCoverEnabled,
} from "@/lib/settings/app-settings";
import { DEFAULT_TRIM_CONCEPT_COPY } from "@/lib/trims/concept-copy";
import { DEFAULT_TRIM_CONCEPTS } from "@/lib/trims/concepts";
import { CoverPageEditor } from "./cover-page-editor";
import { CoverChangesPanel } from "./cover-changes-panel";
import { CoverRegenPanel } from "./cover-regen-panel";
import { TrimsSwitch } from "./trims-switch";
import { GeneralInfoEditor, type ProdSpecOption } from "./general-info-editor";
import { TrimCopyEditor } from "./trim-copy-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cover page · Settings" };

// The two blocks of prose a generated bundle carries, in one place:
//
//   Cover page          — AppSetting coverPageInfoMd, the same on EVERY cover,
//                         printed on the cover sheet below the packaging list.
//   General information — ProdSpec.generalInfoMd, one per Customer × Business
//                         Area, printed inside the cover PDF after that sheet.
//   Packaging wording   — AppSetting trimConceptCopy, the words each KIND of
//                         packaging uses inside the list itself. Keyed by trim
//                         concept rather than by customer (see
//                         src/lib/trims/concept-copy.ts for why), but edited
//                         here, because this is the screen a person opens to
//                         change what a cover says.
//
// REVIEWER-reachable (canReview), not admin-only. Both are supplier-facing
// prose that reviewers own in practice — a standing note like "the pictogram is
// handed over by the supplier" is theirs to write, and routing it through an
// admin only adds latency. The gate holds because neither editor touches
// configuration: the General information tab writes through the narrow
// per-column endpoint, never the full ProdSpec PATCH (which carries outputs,
// languages and approval toggles, and auto-activates draft specs on save).
type Tab = "cover" | "general-info" | "packaging";

export default async function CoverPageSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/dashboard");

  const requestedTab = (await searchParams).tab;
  const tab: Tab =
    requestedTab === "general-info" || requestedTab === "packaging" ? requestedTab : "cover";

  const [markdown, trimsEnabled, trimCopy, specRows] = await Promise.all([
    getCoverPageInfoMd(),
    getTrimsOnCoverEnabled(),
    getStoredTrimConceptCopy(),
    db.prodSpec.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        active: true,
        generalInfoMd: true,
        customer: { select: { name: true } },
        businessArea: { select: { name: true } },
      },
    }),
  ]);

  // Business areas can carry a blank name in live data — fall back so the
  // picker never renders a bare separator.
  const prodSpecs: ProdSpecOption[] = specRows.map((p) => ({
    id: p.id,
    name: p.name,
    customerName: p.customer.name.trim() || "Unnamed client",
    businessAreaName: p.businessArea.name.trim() || "No business area",
    hasGeneralInfo: Boolean(p.generalInfoMd?.trim()),
    active: p.active,
  }));

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "cover", label: "Cover page (all clients)" },
    { key: "general-info", label: "General information" },
    { key: "packaging", label: "Packaging wording" },
  ];

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Cover page</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        The text every bundle carries in front of the layouts. The{" "}
        <strong>cover page</strong> block is the same for every client;{" "}
        <strong>General information</strong> is written per client and business area and prints
        after the cover sheet.
      </p>

      <div className="mt-6 flex gap-1 border-b border-zinc-200">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "cover" ? "/settings/cover-page" : `/settings/cover-page?tab=${t.key}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? "border-zinc-900 font-medium text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "cover" ? (
        <>
          <p className="mt-6 max-w-2xl text-sm text-zinc-500">
            This block prints on the <strong>cover sheet of every bundle</strong>, just below the
            required-packaging list. It&apos;s the same on every cover — use it for company-wide
            notes, contact lines, or standing instructions the supplier should always see.
          </p>
          <div className="mt-6">
            <CoverPageEditor initialMarkdown={markdown} />
          </div>
          <CoverChangesPanel />
          <TrimsSwitch initialEnabled={trimsEnabled} />
          <CoverRegenPanel />
        </>
      ) : tab === "general-info" ? (
        <GeneralInfoEditor prodSpecs={prodSpecs} />
      ) : (
        <TrimCopyEditor
          concepts={DEFAULT_TRIM_CONCEPTS}
          defaults={DEFAULT_TRIM_CONCEPT_COPY}
          initialCopy={trimCopy}
        />
      )}
    </div>
  );
}
