import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getSessionWithRole } from "@/lib/auth-server";
import { getColumnConfig } from "@/lib/monday/column-config";
import { MondayPanel, type BoardSummary } from "./monday-panel";
import { ColumnConfigForm } from "./column-config-form";

export const dynamic = "force-dynamic";

export default async function MondaySettingsPage() {
  const [{ role }, customers, webhooks, columnConfig] = await Promise.all([
    getSessionWithRole(),
    db.customer.findMany({ orderBy: { name: "asc" } }),
    db.mondayWebhook.findMany({ orderBy: { createdAt: "desc" } }),
    getColumnConfig(),
  ]);
  const isAdmin = role === "ADMIN";

  // Collect every board id referenced by a customer config, with the customer
  // names that claim it and the events already registered for it.
  const eventsByBoard = new Map<string, string[]>();
  for (const w of webhooks) {
    const list = eventsByBoard.get(w.boardId) ?? [];
    list.push(w.eventType);
    eventsByBoard.set(w.boardId, list);
  }

  const boardMap = new Map<string, BoardSummary>();
  for (const c of customers) {
    const cfg = parseCustomerConfig(c.config);
    for (const boardId of cfg.mondayBoardIds) {
      const existing = boardMap.get(boardId);
      if (existing) existing.customers.push(c.name);
      else boardMap.set(boardId, { boardId, customers: [c.name], events: eventsByBoard.get(boardId) ?? [] });
    }
  }
  // Include boards that have webhooks but aren't in any config (e.g. ad-hoc).
  for (const [boardId, events] of eventsByBoard) {
    if (!boardMap.has(boardId)) boardMap.set(boardId, { boardId, customers: [], events });
  }

  const boards = [...boardMap.values()].sort((a, b) => a.boardId.localeCompare(b.boardId));

  return (
    <div className="px-8 py-8">
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <Link href="/settings" className="hover:underline">Settings</Link>
        <span>/</span>
        <span className="text-zinc-700">Monday</span>
      </div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Monday webhooks</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Register webhooks per board, verify the columns we sync exist, then run a one-time fill. After that the
        mirror keeps itself current from incoming webhooks. Registry is append-only — deletion is never automated.
      </p>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700">Shared column mapping (all customers)</h2>
        <ColumnConfigForm
          initial={{ columnMapping: columnConfig.columnMapping, requiredFields: columnConfig.requiredFields }}
          updatedAt={columnConfig.updatedAt.toISOString()}
          isAdmin={isAdmin}
        />
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700">Boards</h2>
        <MondayPanel boards={boards} isAdmin={isAdmin} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-700">Registered webhooks</h2>
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
                    No webhooks registered yet.
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
