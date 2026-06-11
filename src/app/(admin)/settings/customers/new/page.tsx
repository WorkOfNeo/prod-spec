import Link from "next/link";
import { requireAdminPage } from "@/lib/auth-server";
import { NETTO_GERMANY_DEFAULT_CONFIG } from "@/lib/customers/config";
import { CustomerForm } from "../[id]/customer-form";

export default async function NewCustomerPage() {
  await requireAdminPage();
  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New customer</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Slug is permanent. Use kebab-case (e.g. <code>netto-germany</code>).
      </p>

      <CustomerForm
        mode="create"
        initial={{
          slug: "",
          name: "",
          config: NETTO_GERMANY_DEFAULT_CONFIG,
        }}
      />
    </div>
  );
}
