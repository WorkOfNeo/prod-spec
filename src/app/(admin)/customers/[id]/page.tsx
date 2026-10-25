import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { parseCustomerConfig } from "@/lib/customers/config";
import { formatDate } from "@/lib/utils";
import { CustomerConfigForm } from "./customer-config-form";
import { SkipSupplierDeliveryBadge } from "@/components/skip-supplier-delivery-badge";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const customer = await db.customer.findUnique({ where: { id }, select: { name: true } });
  return { title: customer?.name ?? "Customer" };
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();

  const { id } = await params;
  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      prodSpecs: { include: { businessArea: true }, orderBy: { name: "asc" } },
      _count: { select: { styles: true } },
    },
  });
  if (!customer) notFound();

  const config = parseCustomerConfig(customer.config);

  return (
    <div className="px-6 py-5">
      <Link href="/customers" className="text-xs text-muted underline">
        ← All customers
      </Link>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em]">{customer.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {customer.country ?? "—"} · {customer.priority ?? "no priority"} ·{" "}
            {customer.mondayItemId ? (
              <span className="font-mono text-xs">monday:{customer.mondayItemId}</span>
            ) : (
              <span>manual</span>
            )}
          </p>
        </div>
      </div>

      {config.skipSupplierDelivery && <SkipSupplierDeliveryBadge className="mt-4" />}

      <section className="mt-6 grid grid-cols-4 gap-4">
        <Stat label="Styles" value={customer._count.styles} />
        <Stat label="Prod specs" value={customer.prodSpecs.length} />
        <Stat label="Active?" value={customer.active ? "yes" : "no"} />
        <Stat label="Last synced" value={formatDate(customer.lastSyncedAt)} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink">Mirrored from Monday</h2>
        <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-2 rounded-lg border border-line bg-subtle p-4 text-sm">
          <Field label="Account">{customer.name}</Field>
          <Field label="Country">{customer.country ?? "—"}</Field>
          <Field label="Location">{customer.location ?? "—"}</Field>
          <Field label="Sales responsible">{customer.salesResponsible ?? "—"}</Field>
          <Field label="Priority">{customer.priority ?? "—"}</Field>
          <Field label="Slug">{customer.slug}</Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          These fields refresh on every Customer sync — edit them in Monday, not here.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink">Customer config (editable)</h2>
        <CustomerConfigForm customerId={customer.id} initial={config} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink">Prod specs</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2">Business area</th>
                <th className="px-4 py-2">Threshold</th>
                <th className="px-4 py-2">Active?</th>
                <th className="px-4 py-2">Fully approved?</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {customer.prodSpecs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted">
                    No prod specs yet. They auto-create when a Style ingests with a known business area.
                  </td>
                </tr>
              ) : (
                customer.prodSpecs.map((ps) => (
                  <tr key={ps.id} className="border-t border-line">
                    <td className="px-4 py-2">{ps.businessArea.name}</td>
                    <td className="px-4 py-2 tabular-nums text-muted">{ps.autoGenerateThresholdPct}%</td>
                    <td className="px-4 py-2 text-muted">{ps.active ? "yes" : "no"}</td>
                    <td className="px-4 py-2">
                      {ps.fullyApproved ? (
                        <span className="inline-flex rounded-full bg-good-soft px-2 py-0.5 text-[11px] font-medium text-good">
                          Approved
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link href={`/prod-specs/${ps.id}`} className="text-xs text-ink underline">
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium">{children}</div>
    </div>
  );
}
