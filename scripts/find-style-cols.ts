import { db } from "@/lib/db";

async function main() {
  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: "6979419195" },
    include: {
      columns: {
        where: {
          OR: [
            { type: "board_relation" },
            { title: { contains: "Customer", mode: "insensitive" } },
            { title: { contains: "Supplier", mode: "insensitive" } },
            { title: { contains: "Business", mode: "insensitive" } },
            { title: { contains: "PO", mode: "insensitive" } },
            { mondayColumnId: "customer__1" },
            { mondayColumnId: "supplier__1" },
          ],
        },
      },
    },
  });
  console.log("Relevant columns on Styles board:");
  for (const c of board?.columns ?? []) {
    console.log(`  ${c.mondayColumnId.padEnd(28)} ${c.type.padEnd(20)} ${c.title}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
