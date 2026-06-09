// Pagination + column-introspection helpers for the bulk Monday sync.
// Built alongside src/lib/monday/client.ts — that module exposes the
// single-page item helpers used by the webhook ingest; this one exposes
// cursor-driven paging needed for bulk mirrors.

import { MondayError, type MondayItem } from "./client";

const MONDAY_API_URL = "https://api.monday.com/v2";

type Config = { token: string; apiVersion: string };

function getConfig(): Config {
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
      "API-Version": apiVersion,
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

// IMPORTANT: must include the BoardRelationValue fragment so paginated
// bulk fetches receive linked_item_ids for `board_relation` columns.
// Monday API 2024-10+ returns `value: null` for those columns under the
// legacy serialization — the real link lives in `linked_item_ids` only.
// The sink's serializeColumnValues backfills `linkedPulseIds` into the
// stored `value` from this field, so downstream readers (ingest,
// extractLinkedItemId, suggestions, /import scan) keep working.
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

export type ItemsPage = { items: MondayItem[]; cursor: string | null };

export async function getBoardItems(boardId: string, limit = 200): Promise<ItemsPage> {
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
    { ids: [boardId], limit },
  );
  const page = data.boards?.[0]?.items_page;
  return { items: page?.items ?? [], cursor: page?.cursor ?? null };
}

export async function getNextItemsPage(cursor: string, limit = 200): Promise<ItemsPage> {
  const data = await gql<{ next_items_page: { cursor: string | null; items: MondayItem[] } }>(
    `query ($cursor: String!, $limit: Int!) {
      next_items_page (cursor: $cursor, limit: $limit) {
        cursor
        items { ${ITEM_FIELDS} }
      }
    }`,
    { cursor, limit },
  );
  return { items: data.next_items_page?.items ?? [], cursor: data.next_items_page?.cursor ?? null };
}

export type BoardMeta = {
  id: string;
  name: string;
  description: string | null;
  columns: Array<{
    id: string;
    title: string;
    type: string;
    description: string | null;
    settings: unknown;
  }>;
};

// Fetch a board's metadata + every column's parsed settings in a single
// GraphQL round-trip. Used by the ghost-DB sink as step 1 (columns first
// so the dropdown-option upserts have a FK target).
export async function getBoardMeta(boardId: string): Promise<BoardMeta | null> {
  const data = await gql<{
    boards: Array<{
      id: string;
      name: string;
      description: string | null;
      columns: Array<{ id: string; title: string; type: string; description: string | null; settings_str: string | null }>;
    }> | null;
  }>(
    `query ($ids: [ID!]) {
      boards (ids: $ids) {
        id
        name
        description
        columns { id title type description settings_str }
      }
    }`,
    { ids: [boardId] },
  );
  const board = data.boards?.[0];
  if (!board) return null;
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    columns: board.columns.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      description: c.description,
      settings: c.settings_str ? safeJsonParse(c.settings_str) : null,
    })),
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Returns the parsed `settings_str` of a column on a board, or null.
// Used to extract dropdown/status labels for the BusinessArea mirror.
export async function getColumnSettings(boardId: string, columnId: string): Promise<unknown> {
  const data = await gql<{
    boards: Array<{ columns: Array<{ id: string; type: string; settings_str: string | null }> | null }>;
  }>(
    `query ($ids: [ID!], $columnIds: [String!]) {
      boards (ids: $ids) {
        columns (ids: $columnIds) { id type settings_str }
      }
    }`,
    { ids: [boardId], columnIds: [columnId] },
  );
  const col = data.boards?.[0]?.columns?.[0];
  if (!col?.settings_str) return null;
  try {
    return JSON.parse(col.settings_str);
  } catch {
    return null;
  }
}
