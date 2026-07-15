import { requireAdminPage } from "@/lib/auth-server";
import { getCoverPageInfoMd } from "@/lib/settings/app-settings";
import { CoverPageEditor } from "./cover-page-editor";
import { CoverRegenPanel } from "./cover-regen-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cover page · Settings" };

// Global cover-page content — app-wide markdown printed on the cover SHEET of
// every generated bundle, below the required-packaging manifest. Distinct from
// each Prod Spec's own "General information" pages (which still ship after the
// cover sheet): this block is the same on every cover, for company-wide notes.
export default async function CoverPageSettingsPage() {
  await requireAdminPage();
  const markdown = await getCoverPageInfoMd();

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Cover page</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        This block prints on the <strong>cover sheet of every bundle</strong>, just below the
        required-packaging list. It&apos;s the same on every cover — use it for company-wide notes,
        contact lines, or standing instructions the supplier should always see. Each Prod Spec&apos;s
        own <strong>General information</strong> pages still ship separately, after the cover sheet.
      </p>
      <div className="mt-6">
        <CoverPageEditor initialMarkdown={markdown} />
      </div>
      <CoverRegenPanel />
    </div>
  );
}
