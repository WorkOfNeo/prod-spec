import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { getBoardColumns } from "@/lib/monday/client";
import { resolveCustomerByBoardId } from "@/lib/customers/resolve";

export const runtime = "nodejs";

// Readiness check: confirm every column id we'd sync for a board actually
// exists on the live board before flipping webhooks on. Cross-references the
// customer's columnMapping + requiredFields against Monday's column metadata.
// Wiki scar (Contrast): a stale/typo'd column id silently resolves to nothing
// and produces empty mirror fields with no error.
export async function GET(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const boardId = req.nextUrl.searchParams.get("boardId");
  if (!boardId) return NextResponse.json({ error: "boardId required" }, { status: 400 });

  let columns;
  try {
    columns = await getBoardColumns(boardId);
  } catch (err) {
    return NextResponse.json({ error: `Failed to fetch board columns: ${(err as Error).message}` }, { status: 502 });
  }

  const byId = new Map(columns.map((c) => [c.id, c]));
  const resolved = await resolveCustomerByBoardId(boardId);

  if (!resolved) {
    return NextResponse.json({
      boardId,
      customer: null,
      warning: "No customer config lists this board id. Add it to a customer's mondayBoardIds first.",
      boardColumns: columns,
    });
  }

  const { customer, config } = resolved;
  const requiredIds = new Set(config.requiredFields.map((f) => f.id));

  // Every mapped column: does its configured id exist on the live board?
  const mapped = Object.entries(config.columnMapping)
    .filter(([, columnId]) => typeof columnId === "string" && columnId.length > 0)
    .map(([field, columnId]) => {
      const col = byId.get(columnId as string);
      return {
        field,
        columnId: columnId as string,
        required: requiredIds.has(columnId as string),
        existsOnBoard: Boolean(col),
        title: col?.title ?? null,
        type: col?.type ?? null,
      };
    });

  // Required fields that don't resolve to a real board column — the dangerous set.
  const requiredMissing = config.requiredFields
    .filter((f) => !byId.has(f.id))
    .map((f) => ({ id: f.id, label: f.label }));

  const mappedIds = new Set(mapped.map((m) => m.columnId));
  const unmappedBoardColumns = columns
    .filter((c) => !mappedIds.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, type: c.type }));

  return NextResponse.json({
    boardId,
    customer: { id: customer.id, slug: customer.slug, name: customer.name },
    ready: mapped.every((m) => m.existsOnBoard) && requiredMissing.length === 0,
    mapped,
    requiredMissing,
    unmappedBoardColumns,
  });
}
