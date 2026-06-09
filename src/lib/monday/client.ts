const MONDAY_API_URL = "https://api.monday.com/v2";

export class MondayError extends Error {
  constructor(
    message: string,
    public readonly errors?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MondayError";
  }
}

type MondayConfig = {
  token: string;
  apiVersion?: string;
};

export type MondayColumnValue = {
  id: string;
  type?: string;
  text: string | null;
  value: string | null;
  // Monday API 2024-10+: board_relation columns return `value: null` from
  // the legacy serialization, and the real link lives in `linked_item_ids`
  // exposed via the `... on BoardRelationValue` GraphQL fragment. We
  // query for it explicitly so ingest / sink can read the link. Older
  // boards that still emit the legacy `{ linkedPulseIds: [...] }` payload
  // in `value` keep working — extractLinkedItemId handles both.
  linked_item_ids?: string[] | null;
  display_value?: string | null;
};

export type MondayItem = {
  id: string;
  name: string;
  board: { id: string };
  group?: { id: string; title: string } | null;
  column_values: MondayColumnValue[];
};

export type MondaySubitem = MondayItem;

export type MondayWebhookRecord = {
  id: string;
  board_id: string;
  event: string;
  config: string | null;
};

function getConfig(): MondayConfig {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new MondayError("MONDAY_API_TOKEN not set");
  return { token, apiVersion: process.env.MONDAY_API_VERSION ?? "2024-10" };
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { token, apiVersion } = getConfig();
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": apiVersion ?? "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MondayError(`Monday HTTP ${res.status}: ${text.slice(0, 500)}`, undefined, res.status);
  }

  const body = (await res.json()) as { data?: T; errors?: unknown; error_message?: string };

  if (body.errors || body.error_message) {
    throw new MondayError(body.error_message ?? "GraphQL errors", body.errors ?? body.error_message);
  }
  if (!body.data) throw new MondayError("Empty response from Monday");
  return body.data;
}

const ITEM_FIELDS = `
  id
  name
  group { id title }
  board { id }
  column_values {
    id type text value
    ... on BoardRelationValue { linked_item_ids display_value }
    ... on MirrorValue { display_value }
  }
`;

export async function getItem(itemId: string | number): Promise<MondayItem | null> {
  const data = await gql<{ items: MondayItem[] | null }>(
    `query ($ids: [ID!]) { items (ids: $ids) { ${ITEM_FIELDS} } }`,
    { ids: [String(itemId)] },
  );
  return data.items?.[0] ?? null;
}

export async function getBoardItems(boardId: string | number, limit = 100): Promise<MondayItem[]> {
  const data = await gql<{
    boards: Array<{ items_page: { cursor: string | null; items: MondayItem[] } }>;
  }>(
    `query ($ids: [ID!], $limit: Int!) {
      boards (ids: $ids) {
        items_page (limit: $limit) {
          cursor
          items { ${ITEM_FIELDS} }
        }
      }
    }`,
    { ids: [String(boardId)], limit },
  );
  return data.boards?.[0]?.items_page?.items ?? [];
}

// Wiki gotcha: Monday subitems live on a SEPARATE board id, but the API
// exposes them via the parent item's `subitems` field. This helper goes
// through the parent — callers that need the subitem board id can read
// it from `subitem.board.id` on the returned items.
export async function getSubitems(parentItemId: string | number): Promise<MondaySubitem[]> {
  const data = await gql<{
    items: Array<{ subitems: MondaySubitem[] | null }> | null;
  }>(
    `query ($ids: [ID!]) {
      items (ids: $ids) {
        subitems { ${ITEM_FIELDS} }
      }
    }`,
    { ids: [String(parentItemId)] },
  );
  return data.items?.[0]?.subitems ?? [];
}

export type WebhookEvent =
  | "create_item"
  | "create_subitem"
  | "change_column_value"
  | "change_status_column_value"
  | "change_specific_column_value"
  | "item_archived"
  | "item_deleted"
  | "item_moved_to_any_group";

export async function listWebhooks(boardId: string | number): Promise<MondayWebhookRecord[]> {
  const data = await gql<{ webhooks: MondayWebhookRecord[] | null }>(
    `query ($boardId: ID!) {
      webhooks (board_id: $boardId) { id board_id event config }
    }`,
    { boardId: String(boardId) },
  );
  return data.webhooks ?? [];
}

export async function createWebhook(input: {
  boardId: string | number;
  url: string;
  event: WebhookEvent;
  config?: Record<string, unknown>;
}): Promise<MondayWebhookRecord> {
  const data = await gql<{ create_webhook: MondayWebhookRecord }>(
    `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
      create_webhook (board_id: $boardId, url: $url, event: $event, config: $config) {
        id board_id event config
      }
    }`,
    {
      boardId: String(input.boardId),
      url: input.url,
      event: input.event,
      config: input.config ? JSON.stringify(input.config) : undefined,
    },
  );
  return data.create_webhook;
}

// IMPORTANT: we intentionally do NOT expose `delete_webhook` here. Webhook
// deletion is destructive across system boundaries and must be a manual,
// user-initiated action only. See the rule in CLAUDE.md.

export async function changeItemValue(input: {
  boardId: string | number;
  itemId: string | number;
  columnId: string;
  value: string;
}): Promise<void> {
  await gql(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value (board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    {
      boardId: String(input.boardId),
      itemId: String(input.itemId),
      columnId: input.columnId,
      value: input.value,
    },
  );
}

export function columnText(item: MondayItem, columnId: string): string {
  const col = item.column_values.find((c) => c.id === columnId);
  if (!col) return "";
  // Mirror columns (e.g. Pre-Order "🌍 Country of Origin") return an empty
  // `text`; their value lives in `display_value`. Fall back to it so a
  // mapped mirror column resolves like any other.
  if (col.text && col.text.trim()) return col.text;
  return col.display_value ?? "";
}

export function columnValue(item: MondayItem, columnId: string): unknown {
  const col = item.column_values.find((c) => c.id === columnId);
  if (!col) return null;
  if (col.value) {
    try {
      return JSON.parse(col.value);
    } catch {
      return col.value;
    }
  }
  // Board-relation columns return `value: null` on Monday API 2024-10+;
  // their link payload comes through `linked_item_ids`. Synthesize the
  // legacy `{ linkedPulseIds: [{ linkedPulseId }] }` shape so the rest
  // of the codebase (extractLinkedItemId, etc.) keeps working.
  if (Array.isArray(col.linked_item_ids) && col.linked_item_ids.length > 0) {
    return {
      linkedPulseIds: col.linked_item_ids.map((id) => ({ linkedPulseId: String(id) })),
    };
  }
  return null;
}
