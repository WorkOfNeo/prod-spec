import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { parseCustomerConfig } from "@/lib/customers/config";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [customers, webhooks] = await Promise.all([
    db.customer.findMany({ orderBy: { name: "asc" } }),
    db.mondayWebhook.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Customer config drives template generation. Adding a new customer is a config change, not a code change.
      </p>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700">Customers</h2>
          <Link
            href="/settings/customers/new"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            + Add customer
          </Link>
        </div>
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Monday boards</th>
                <th className="px-4 py-2">Doc types</th>
                <th className="px-4 py-2">SharePoint</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    No customers yet. The first Monday webhook event will create Netto Germany.
                  </td>
                </tr>
              ) : (
                customers.map((c) => {
                  const cfg = parseCustomerConfig(c.config);
                  return (
                    <tr key={c.id} className="border-t border-zinc-100">
                      <td className="px-4 py-2 font-mono text-xs">{c.slug}</td>
                      <td className="px-4 py-2">{c.name}</td>
                      <td className="px-4 py-2 text-xs text-zinc-600">
                        {cfg.mondayBoardIds.length ? cfg.mondayBoardIds.join(", ") : "—"}
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-600">
                        {cfg.enabledDocTypes.length}/4
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">
                        {c.sharepointPath ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link href={`/settings/customers/${c.id}`} className="text-xs text-zinc-700 underline">
                          Edit
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700">Monday webhooks</h2>
          <Link
            href="/settings/monday"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            Register &amp; fill →
          </Link>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Append-only registry. Deletion is a manual action, never automated (project rule). Register webhooks,
          check synced columns, and run the one-time fill from the{" "}
          <Link href="/settings/monday" className="underline">Monday page</Link>.
        </p>
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Board</th>
                <th className="px-4 py-2">Event</th>
                <th className="px-4 py-2">Monday webhook id</th>
                <th className="px-4 py-2">Registered</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                    No webhooks registered. POST to /api/admin/webhooks to bootstrap.
                  </td>
                </tr>
              ) : (
                webhooks.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100">
                    <td className="px-4 py-2 font-mono text-xs">{w.boardId}</td>
                    <td className="px-4 py-2">{w.eventType}</td>
                    <td className="px-4 py-2 font-mono text-xs">{w.mondayWebhookId}</td>
                    <td className="px-4 py-2 text-zinc-500">{formatDate(w.createdAt)}</td>
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
