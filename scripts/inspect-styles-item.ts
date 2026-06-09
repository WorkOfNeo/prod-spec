// Inspect one Styles item's column_values to understand what the customer
// link column emits. Lets us pick the right env var values.

import { db } from "@/lib/db";

async function main() {
  const stylesBoard = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: "6979419195" },
  });
  if (!stylesBoard) throw new Error("Styles ghost board not found");

  const sample = await db.mondayGhostItem.findFirst({
    where: { boardId: stylesBoard.id },
    orderBy: { lastSyncedAt: "desc" },
  });
  console.log("Sample Styles item:");
  console.log("  name:", sample?.name);
  console.log("  monday id:", sample?.mondayItemId);
  console.log("  column_values:");
  const cvs = (sample?.columnValues ?? []) as Array<{
    id: string;
    text: string | null;
    type: string | null;
    value: unknown;
  }>;
  for (const cv of cvs) {
    if (cv.value !== null || (cv.text && cv.text.length > 0)) {
      console.log(`    ${cv.id} (${cv.type}) text=${JSON.stringify(cv.text)} value=${JSON.stringify(cv.value)}`);
    }
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
