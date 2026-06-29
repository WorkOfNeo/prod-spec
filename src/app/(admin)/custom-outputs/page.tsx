import { redirect } from "next/navigation";

// The Custom Outputs page has been retired — the Output Builder is now the
// single outputs surface, and its list page hosts the Document types card
// (at #doc-types). Redirect any old links/bookmarks there.
export const metadata = { title: "Custom outputs" };

export default function CustomOutputsRedirect() {
  redirect("/output-builder");
}
