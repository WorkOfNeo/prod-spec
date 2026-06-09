// /sync was folded into /monday's Sync tab. Existing links across the app
// (customers, suppliers, settings) still point here — redirect transparently.

import { redirect } from "next/navigation";

export default function SyncRedirect() {
  redirect("/monday?tab=sync");
}
