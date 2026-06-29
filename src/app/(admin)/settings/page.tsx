import { getAutoGenerateEnabled, getSupplierReviewCcEmails } from "@/lib/settings/app-settings";
import { listPulledStyles } from "@/lib/po/pull-by-po";
import { AutoGenerateSetting } from "./auto-generate-setting";
import { SupplierContactEmailSetting } from "./supplier-contact-email-setting";
import { PullStyleByPo } from "./pull-style-by-po";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

// General settings landing. Catalogue config (customers, care labels,
// certificates, QR codes, Monday webhooks) lives under their own sidebar
// entries; global, app-wide flags that don't belong to a catalogue land
// here — starting with the auto-generate master switch.
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdminPage();

  const [autoGenerateEnabled, supplierReviewCcEmails, pulledStyles] = await Promise.all([
    getAutoGenerateEnabled(),
    getSupplierReviewCcEmails(),
    listPulledStyles(),
  ]);

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Global configuration for this instance.
      </p>

      <div className="mt-6 grid max-w-2xl gap-4">
        <AutoGenerateSetting initialEnabled={autoGenerateEnabled} />
        <SupplierContactEmailSetting initialEmails={supplierReviewCcEmails.join(", ")} />
        <PullStyleByPo initialPulled={pulledStyles} />
      </div>

      <p className="mt-6 max-w-2xl text-xs text-zinc-500">
        Catalogue config lives under its own <strong>Settings</strong> menu entries — Monday, care
        labels, certificates, QR codes, translations, countries, languages, and business areas.
      </p>
    </div>
  );
}
