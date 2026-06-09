// For each board, check how many items have a non-null customer__1
// board_relation value. Used to figure out where customer→style linkage
// actually lives in Monday.

import { db } from "@/lib/db";

async function main() {
  const boards = await db.mondayGhostBoard.findMany();
  for (const b of boards) {
    const total = await db.mondayGhostItem.count({ where: { boardId: b.id } });
    // Count items where any column id contains "customer" and the value
    // has linkedPulseIds. Cheap heuristic.
    const linked = await db.$queryRaw<Array<{ c: bigint }>>`
      SELECT count(*)::bigint as c
      FROM monday_ghost_items
      WHERE "boardId" = ${b.id}
        AND ("columnValues"::text LIKE '%linkedPulseIds%')
    `;
    const customerLinked = await db.$queryRaw<Array<{ c: bigint }>>`
      SELECT count(*)::bigint as c
      FROM monday_ghost_items
      WHERE "boardId" = ${b.id}
        AND ("columnValues"::text ~ '"id"\\s*:\\s*"customer[^"]*"[^{]*\\{[^}]*linkedPulseIds[^}]*\\[[^\\]]*\\{')
    `;
    console.log(
      `${(b.label ?? b.name).padEnd(20)} ${b.mondayBoardId.padEnd(11)} ${total} items · ~${linked[0]?.c ?? 0} with any board-relation linkage · ~${customerLinked[0]?.c ?? 0} via a customer* column`,
    );
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
