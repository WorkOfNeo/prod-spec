import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { parseCustomerConfig } from "@/lib/customers/config";
import { CustomerForm } from "./customer-form";

export const dynamic = "force-dynamic";

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) notFound();

  const config = parseCustomerConfig(customer.config);

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{customer.name}</h1>
      <p className="mt-1 text-sm text-zinc-500">Slug: <code>{customer.slug}</code></p>

      <CustomerForm
        mode="edit"
        customerId={customer.id}
        initial={{
          slug: customer.slug,
          name: customer.name,
          config,
        }}
      />
    </div>
  );
}
