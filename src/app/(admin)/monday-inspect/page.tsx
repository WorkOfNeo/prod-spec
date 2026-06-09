// /monday-inspect lives inside /monday now (Inspector tab). Forward existing
// bookmarks. We pass the boardId through so a saved "?boardId=…" link still
// lands on the right board.

import { redirect } from "next/navigation";

export default async function MondayInspectRedirect({
  searchParams,
}: {
  searchParams: Promise<{ boardId?: string }>;
}) {
  const { boardId } = await searchParams;
  const qs = boardId ? `&boardId=${encodeURIComponent(boardId)}` : "";
  redirect(`/monday?tab=inspector${qs}`);
}
