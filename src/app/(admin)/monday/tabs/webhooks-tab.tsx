import { formatDate } from "@/lib/utils";

type WebhookRow = {
  id: string;
  boardId: string;
  eventType: string;
  mondayWebhookId: string;
  createdAt: Date;
};

// Monday webhook registry — moved here from the Settings page. Append-only
// by design: deletion is a manual, user-initiated action and is never
// automated (project rule).
export function WebhooksTab({ webhooks }: { webhooks: WebhookRow[] }) {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-zinc-700">Monday webhooks</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Append-only registry. Deletion is a manual action, never automated (project rule).
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
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
  );
}
