// Find a Styles item that has a non-null customer__1 board_relation,
// so we can confirm the JSON shape (linkedPulseIds[]).

import { db } from "@/lib/db";

async function main() {
  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: "6979419195" },
  });
  if (!board) throw new Error("board not found");

  const sample = await db.$queryRaw<Array<{ id: string; name: string; columnValues: unknown }>>`
    SELECT id, name, "columnValues"
    FROM monday_ghost_items
    WHERE "boardId" = ${board.id}
      AND "columnValues"::text LIKE '%customer__1%linkedPulseIds%'
    LIMIT 1
  `;
  if (sample.length === 0) {
    console.log("No item with non-null customer link found. Inspecting customer__1 column on first item with any value…");
    const any = await db.mondayGhostItem.findFirst({
      where: { boardId: board.id },
    });
    const cv = ((any?.columnValues ?? []) as Array<{ id: string; value: unknown; text: string | null }>).find(
      (c) => c.id === "customer__1",
    );
    console.log("customer__1:", JSON.stringify(cv, null, 2));
  } else {
    const cv = ((sample[0].columnValues ?? []) as Array<{ id: string; value: unknown; text: string | null }>).find(
      (c) => c.id === "customer__1",
    );
    console.log(`Sample style: ${sample[0].name}`);
    console.log("customer__1:", JSON.stringify(cv, null, 2));
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
