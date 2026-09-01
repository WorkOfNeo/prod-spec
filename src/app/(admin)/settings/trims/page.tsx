import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview, isAdmin } from "@/lib/roles";
import {
  getTrimLabelOverrides,
  getTrimLayoutConcepts,
  getTrimRules,
} from "@/lib/settings/app-settings";
import { loadTrimConceptRows } from "@/lib/trims/catalogue";
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
  const [rules, overrides, layoutConcepts, concepts] = await Promise.all([
    getTrimRules(),
    getTrimLabelOverrides(),
    getTrimLayoutConcepts(),
    loadTrimConceptRows(),
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
        that mapping would never be finished. Every trim value is matched instead onto one of the
        cover page&rsquo;s <strong>packaging rows</strong>, the shared list that layouts are matched
        onto too, so a new customer&rsquo;s layout is recognised the moment it is created.
      </p>

      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
        The keyword rules below are a <strong>suggestion</strong>: they pre-fill a value&rsquo;s row
        so the common vocabulary needs no typing, and a value keeps following its suggestion until
        someone decides otherwise. Accepting a suggestion turns it into a decision that no later
        rule edit can change.
      </p>

      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-500">
        The vocabulary below is scoped to the <strong>generation PO cutoff</strong> — only orders
        that will actually be printed. Words that survive only on pre-cutoff orders are not put in
        front of anyone to map. The rows themselves — adding one, renaming one, and the wording each
        prints on a cover — live on{" "}
        <Link
          href="/settings/cover-page?tab=packaging"
          className="font-medium text-zinc-700 underline underline-offset-2"
        >
          Cover page › Packaging rows
        </Link>
        .
      </p>

      <TrimsEditor
        concepts={concepts}
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
