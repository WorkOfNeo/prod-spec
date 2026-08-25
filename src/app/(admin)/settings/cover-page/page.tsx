import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { getCoverPageInfoMd } from "@/lib/settings/app-settings";
import { CoverPageEditor } from "./cover-page-editor";
import { CoverChangesPanel } from "./cover-changes-panel";
import { CoverRegenPanel } from "./cover-regen-panel";
import { GeneralInfoEditor, type ProdSpecOption } from "./general-info-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cover page · Settings" };

// The two blocks of prose a generated bundle carries, in one place:
//
//   Cover page          — AppSetting coverPageInfoMd, the same on EVERY cover,
//                         printed on the cover sheet below the packaging list.
//   General information — ProdSpec.generalInfoMd, one per Customer × Business
//                         Area, printed inside the cover PDF after that sheet.
//
// REVIEWER-reachable (canReview), not admin-only. Both are supplier-facing
// prose that reviewers own in practice — a standing note like "the pictogram is
// handed over by the supplier" is theirs to write, and routing it through an
// admin only adds latency. The gate holds because neither editor touches
// configuration: the General information tab writes through the narrow
// per-column endpoint, never the full ProdSpec PATCH (which carries outputs,
// languages and approval toggles, and auto-activates draft specs on save).
type Tab = "cover" | "general-info";

export default async function CoverPageSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/dashboard");

  const tab: Tab = (await searchParams).tab === "general-info" ? "general-info" : "cover";

  const [markdown, specRows] = await Promise.all([
    getCoverPageInfoMd(),
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
            href={t.key === "cover" ? "/settings/cover-page" : "/settings/cover-page?tab=general-info"}
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
          <CoverRegenPanel />
        </>
      ) : (
        <GeneralInfoEditor prodSpecs={prodSpecs} />
      )}
    </div>
  );
}
