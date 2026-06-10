import { formatDate } from "@/lib/utils";
import { RegisterWebhooksButton } from "./register-webhooks-button";

type WebhookRow = {
  id: string;
  boardId: string;
  boardLabel: string;
  eventType: string;
  mondayWebhookId: string;
  createdAt: Date;
};

// One normalized line of webhook activity, parsed server-side from the Log
// table so this component just renders readable values.
type WebhookActivityRow = {
  id: string;
  at: Date;
  level: string;
  event: string;
  board: string;
  item: string;
  detail: string;
};

// Raw Monday event names → human labels. Keeps the activity log readable
// without losing the precise event (shown on hover via title).
const EVENT_LABELS: Record<string, string> = {
  create_item: "Item created",
  create_subitem: "Subitem created",
  change_column_value: "Column changed",
  change_status_column_value: "Status changed",
  change_specific_column_value: "Column changed",
  item_archived: "Item archived",
  item_deleted: "Item deleted",
  item_moved_to_any_group: "Item moved",
  error: "Error",
  info: "Info",
};

function prettyEvent(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

function LevelBadge({ level }: { level: string }) {
  const cls =
    level === "ERROR"
      ? "bg-red-100 text-red-800"
      : level === "WARN"
        ? "bg-amber-100 text-amber-800"
        : "bg-zinc-100 text-zinc-700";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {level.toLowerCase()}
    </span>
  );
}

// Monday webhook registry + recent activity. Append-only by design:
// deletion is a manual, user-initiated action and is never automated
// (project rule).
export function WebhooksTab({
  webhooks,
  activity,
}: {
  webhooks: WebhookRow[];
  activity: WebhookActivityRow[];
}) {
  return (
    <div className="flex flex-col gap-8">
      {/* ──────── Registered webhooks ──────── */}
      <section>
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-700">Monday webhooks</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Append-only registry. Deletion is a manual action, never automated (project rule).
              <strong> Register</strong> subscribes the Pre-Order, Styles, Customers and Suppliers
              boards so changes flow in live.
            </p>
          </div>
          <RegisterWebhooksButton />
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
                    No webhooks registered. Click <strong>Register</strong> above to bootstrap.
                  </td>
                </tr>
              ) : (
                webhooks.map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100">
                    <td className="px-4 py-2">
                      <span className="font-medium text-zinc-700">{w.boardLabel}</span>
                      <span className="ml-2 font-mono text-xs text-zinc-400">{w.boardId}</span>
                    </td>
                    <td className="px-4 py-2">{prettyEvent(w.eventType)}</td>
                    <td className="px-4 py-2 font-mono text-xs">{w.mondayWebhookId}</td>
                    <td className="px-4 py-2 text-zinc-500">{formatDate(w.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ──────── Webhook activity log ──────── */}
      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold text-zinc-700">Webhook activity</h2>
          <p className="mt-1 text-xs text-zinc-500">
            The most recent events Monday has pushed to us (newest first). Use it to confirm a board
            is live — change something on Monday and it should appear here within seconds.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Event</th>
                <th className="px-4 py-2">Board</th>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {activity.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    No webhook events received yet. Once a board is registered, edits on Monday show
                    up here.
                  </td>
                </tr>
              ) : (
                activity.map((a) => (
                  <tr key={a.id} className="border-t border-zinc-100 align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-500">
                      {formatDate(a.at)}
                    </td>
                    <td className="px-4 py-2">
                      <LevelBadge level={a.level} />
                    </td>
                    <td className="px-4 py-2" title={a.event}>
                      {prettyEvent(a.event)}
                    </td>
                    <td className="px-4 py-2 text-zinc-700">{a.board}</td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">{a.item}</td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {a.detail ? <span title={a.detail}>{a.detail.slice(0, 120)}</span> : "—"}
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
