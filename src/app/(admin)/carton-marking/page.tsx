import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { loadCartonMarkingBoard, BOARD_ASSET_CAP } from "@/lib/carton-groups/board";
import { CartonMarkingBoard } from "./carton-marking-board";

export const dynamic = "force-dynamic";

// The carton marking board — every carton marking we have generated, grouped by
// PO, newest delivered to SharePoint first.
//
// Two jobs, both aimed at reviewers rather than admins:
//  • FIND AND CHECK a marking — open the delivered file or its folder, and
//    override one that is already approved but wrong.
//  • DECLARE A SHARED CARTON — when several styles on a PO are packed in one
//    box, group them so ONE marking covers the box instead of one per style.
//
// Visible to reviewers and admins alike (it sits with Reviews in the sidebar),
// so it gates on canReview rather than the admin role — consistent with
// /carton-customize, where finalizing a carton is already treated as reviewing.
export const metadata = { title: "Carton Marking" };

export default async function CartonMarkingPage() {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/dashboard");

  const board = await loadCartonMarkingBoard();

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Carton Marking</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Every carton marking we have generated — approved, pending or rejected — grouped by PO,
        newest delivered to SharePoint first.
      </p>

      <CartonMarkingBoard pos={board.pos} truncated={board.truncated} cap={BOARD_ASSET_CAP} />
    </div>
  );
}
