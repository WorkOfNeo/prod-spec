import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { MondayError } from "@/lib/monday/client";

export const runtime = "nodejs";

const MONDAY_API_URL = "https://api.monday.com/v2";

// Discovery endpoint — given a Monday boardId, returns every column's id,
// title, type, and parsed settings, plus the first item's column_values
// so you can see what each column actually emits. Use this output to fill
// in the MONDAY_*_COL_* env vars without leaving the app.
//
// Usage: GET /api/admin/monday/columns?boardId=6979419195
export async function GET(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const boardId = req.nextUrl.searchParams.get("boardId");
  if (!boardId) {
    return NextResponse.json(
      { error: "boardId query param required (e.g. ?boardId=6979419195)" },
      { status: 400 },
    );
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "MONDAY_API_TOKEN not set" }, { status: 500 });
  }

  const apiVersion = process.env.MONDAY_API_VERSION ?? "2024-10";
  const query = `query ($ids: [ID!]) {
    boards (ids: $ids) {
      id
      name
      description
      columns { id title type description settings_str }
      items_page (limit: 1) {
        items {
          id
          name
          column_values { id type text value }
        }
      }
    }
  }`;

  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": apiVersion },
    body: JSON.stringify({ query, variables: { ids: [String(boardId)] } }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Monday HTTP ${res.status}`, body: text.slice(0, 1000) },
      { status: 502 },
    );
  }

  const body = (await res.json()) as {
    data?: {
      boards?: Array<{
        id: string;
        name: string;
        description: string | null;
        columns: Array<{ id: string; title: string; type: string; description: string | null; settings_str: string | null }>;
        items_page?: { items: Array<{ id: string; name: string; column_values: Array<{ id: string; type: string; text: string | null; value: string | null }> }> };
      }>;
    };
    errors?: unknown;
    error_message?: string;
  };

  if (body.errors || body.error_message) {
    throw new MondayError(body.error_message ?? "GraphQL errors", body.errors ?? body.error_message);
  }

  const board = body.data?.boards?.[0];
  if (!board) return NextResponse.json({ error: `Board ${boardId} not found` }, { status: 404 });

  // Parse settings_str for each column so dropdown labels etc. are
  // visible directly without manual JSON parsing.
  const columns = board.columns.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    description: c.description,
    settings: c.settings_str ? safeJsonParse(c.settings_str) : null,
  }));

  // Same for the sample item's column values.
  const sampleItem = board.items_page?.items?.[0];
  const sample = sampleItem
    ? {
        id: sampleItem.id,
        name: sampleItem.name,
        columns: sampleItem.column_values.map((cv) => ({
          id: cv.id,
          type: cv.type,
          text: cv.text,
          value: cv.value ? safeJsonParse(cv.value) : null,
        })),
      }
    : null;

  return NextResponse.json({
    board: { id: board.id, name: board.name, description: board.description },
    columns,
    sample,
  });
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
