// Smoke test for the Monday → ghost sink.
// Sinks one board (Suppliers — smallest) and prints what landed.
//
// Run: npx tsx --env-file=.env scripts/sink-smoke.ts

import { sinkBoard } from "@/lib/monday/sink";
import { db } from "@/lib/db";
import { MONDAY_BOARDS } from "@/lib/monday/boards";

async function main() {
  const boardId = MONDAY_BOARDS.suppliers;
  console.log(`Sinking board ${boardId} (Suppliers)...`);
  const result = await sinkBoard(boardId);
  console.log("Result:", JSON.stringify(result, null, 2));

  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: boardId },
    include: {
      _count: { select: { columns: true, items: true } },
      columns: {
        where: { type: { in: ["dropdown", "status", "color"] } },
        include: { _count: { select: { options: true } } },
      },
    },
  });
  console.log("\nGhost board row:");
  console.log(JSON.stringify(board, null, 2));

  const sampleItem = await db.mondayGhostItem.findFirst({
    where: { boardId: board?.id },
    orderBy: { name: "asc" },
  });
  console.log("\nFirst item:");
  console.log(JSON.stringify(sampleItem, null, 2));

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
