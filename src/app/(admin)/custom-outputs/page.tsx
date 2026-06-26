import { redirect } from "next/navigation";

// The Custom Outputs page has been retired — the Output Builder is now the
// single outputs surface, and its header hosts the Document types popup
// (?docTypes=1). Redirect any old links/bookmarks there.
export const metadata = { title: "Custom outputs" };

export default function CustomOutputsRedirect() {
  redirect("/output-builder");
}
