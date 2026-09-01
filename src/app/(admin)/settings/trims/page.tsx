import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview, isAdmin } from "@/lib/roles";
import {
  getTrimLabelOverrides,
  getTrimLayoutConcepts,
  getTrimRules,
} from "@/lib/settings/app-settings";
import { DEFAULT_TRIM_CONCEPTS } from "@/lib/trims/concepts";
import { TrimsEditor } from "./trims-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trims · Settings" };

// What each Monday "Trims" entry means, and therefore what a cover page lists.
//
// REVIEWER-reachable for the same reason as the cover-page prose next door:
// deciding that "Wash Care Label with Oeko-tex Logo" is a care label is
// reviewer knowledge, not configuration, and it changes nothing but the words
// on a cover. Nothing on this screen renders a PDF, arms a queue row or sends
// anything; the rebuild that follows lives on the Cover page screen and is its
// own explicit act.
export default async function TrimsSettingsPage() {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/dashboard");

  // Only the three configuration blobs are read here. The survey of live trim
  // values is a full-fleet scan — seconds against a remote database — and
  // blocking first paint on it would make the screen feel broken while a person
  // waits to edit one keyword. The editor fetches it after paint instead.
  const [rules, overrides, layoutConcepts] = await Promise.all([
    getTrimRules(),
    getTrimLabelOverrides(),
    getTrimLayoutConcepts(),
  ]);
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-lg font-semibold text-zinc-900">Trims</h1>
      <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
        Every style carries a <strong>Trims</strong> list on Monday — the buyer&rsquo;s list of what
        the order needs. The cover page prints that list in Monday&rsquo;s own words so the supplier
        can tick it off, and marks each line as something we produce, something supplied
        separately, or a packing instruction with no artwork.
      </p>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
        A trim is never matched to one layout — &ldquo;Care label&rdquo; exists once per customer and
        that mapping would never be finished. Both sides are matched onto a shared{" "}
        <strong>concept</strong> instead, by the keyword rules below, so a new customer&rsquo;s
        layout is recognised the moment it is created. Only genuinely new vocabulary needs a person.
      </p>

      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
        The vocabulary below is scoped to the <strong>generation PO cutoff</strong> — only orders
        that will actually be printed. Words that survive only on pre-cutoff orders are not put in
        front of anyone to map.
        What a cover <em>says</em> about each concept — the standing note, and the wording used
        while a document is still to come — is edited on{" "}
        <Link
          href="/settings/cover-page?tab=packaging"
          className="font-medium text-zinc-700 underline underline-offset-2"
        >
          Cover page › Packaging wording
        </Link>
        , with the rest of the cover prose.
      </p>

      <TrimsEditor
        concepts={DEFAULT_TRIM_CONCEPTS}
        initialRules={rules}
        initialOverrides={overrides}
        initialLayoutConcepts={layoutConcepts}
        // Reviewers decide what a trim means and can clear any single decision
        // here; dropping the whole stored set is ADMIN, matching the API.
        canPurge={isAdmin(role)}
      />
    </div>
  );
}
