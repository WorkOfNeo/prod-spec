import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { getColourAliases } from "@/lib/settings/app-settings";
import { ColourAliasEditor } from "./colour-alias-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Colour aliases · Settings" };

// Which spellings mean one colour — the vocabulary behind the per-composition
// care-label split. REVIEWER-reachable for the same reason as Trims: reading
// "LGM" on a style and "Grey melange" in its composition and knowing they are
// the same grey is reviewer knowledge, not configuration. Nothing here renders
// a PDF, arms a queue row or sends anything.
export default async function ColourAliasesSettingsPage() {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/dashboard");

  const groups = await getColourAliases();
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-lg font-semibold text-zinc-900">Colour aliases</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
        A pack that ships two qualities states both compositions in one field —{" "}
        <span className="font-mono text-[12px]">Pink: 95% Cotton 5% Elastane, Grey melange: 57%…</span>{" "}
        — and a layout with <strong>Split per composition</strong> gives each colour its own label to
        approve. That only happens when every part is labelled with a colour the style actually
        declares, and the match is exact: it must never guess that one colour word means another.
      </p>
      <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
        The same colour is often written two ways, though — the abbreviation in the style name
        (<span className="font-mono text-[12px]">LGM</span>) and the spelt-out colour in the
        composition (<span className="font-mono text-[12px]">Grey melange</span>). Each group below
        declares such a pair. Nothing is inferred: an alias exists because someone wrote it here.
      </p>

      <ColourAliasEditor initialGroups={groups} />
    </div>
  );
}
