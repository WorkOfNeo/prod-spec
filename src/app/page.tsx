import { redirect } from "next/navigation";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";

export default function Home() {
  // Test phase: the app opens on the per-user task list — unfinished
  // reviews must be the first thing a returning user sees. With the kill
  // switch thrown (REVIEW_FOLLOW_THROUGH_DISABLED=true) it's the plain
  // styles workflow again.
  redirect(reviewFollowThroughEnabled() ? "/dashboard" : "/styles");
}
