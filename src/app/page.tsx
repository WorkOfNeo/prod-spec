import { redirect } from "next/navigation";

export default function Home() {
  // The app opens on the per-user task list — unfinished reviews must be
  // the first thing a returning user sees, not a buried menu item.
  redirect("/dashboard");
}
