import Link from "next/link";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import {
  loadLookalikes,
  LOOKALIKE_MATCH_LABELS,
  type LookalikeMatch,
  type LookalikeSubject,
} from "@/lib/styles/related";

// =====================================================
// "You may be looking at the wrong row" — the style-detail backstop.
//
// Monday's Pre-Order board duplicates a style row per Purchase Order with the
// SAME name, each covering a different slice of the size run. A reviewer who
// opens the wrong one sees a page where absolutely nothing is wrong (green
// status, no missing fields) and reasonably concludes the style is broken. The
// actual report that prompted this: "3 sizes, should be 2" — two rows, two
// POs, one name. See src/lib/styles/related.ts for the detection.
//
// So this card is pure orientation. It does not warn about a defect; it says
// "here are the rows that look like this one, and here is the one you're
// standing on". The "you are here" marker is the entire point — a list of
// links without it just tells someone there's ambiguity without resolving it.
//
// Renders NOTHING when there are no lookalikes, which is the overwhelmingly
// common case. A card that appears on every style would be ignored by week
// two, taking the real ones with it.
// =====================================================

export type RelatedRowsCardProps = {
  // The row the user is currently on — rendered inline with the others so the
  // comparison is like-for-like, and marked "you are here".
  current: LookalikeSubject;
  // Other rows that plausibly describe the same product on a DIFFERENT PO,
  // already ranked strongest-match-first by findLookalikes(). Never empty:
  // the loader returns null instead, so the page renders nothing.
  related: LookalikeMatch[];
  // Outer spacing, so the caller can place the card without wrapping it in a
  // <div> — a wrapper would leave an empty, margin-bearing element on every
  // style that has no lookalikes, which is nearly all of them.
  className?: string;
};

// "3 sizes (19-22, 23-26, …)" — the size run is the field that actually
// differed in the reported mix-up, so it carries the count AND a preview
// rather than just one or the other. Capped at three labels; the full run is
// on the row's title attribute.
function sizeSummary(sizes: string[]): string {
  if (sizes.length === 0) return "no size run";
  const shown = sizes.slice(0, 3).join(", ");
  const more = sizes.length > 3 ? ", …" : "";
  return `${sizes.length} size${sizes.length === 1 ? "" : "s"} (${shown}${more})`;
}

// One line of the card. `current` rows are inert text; the rest are links to
// their own style page, which is the action the whole card exists to prompt.
function Row({
  poNumber,
  sizes,
  eanStatus,
  href,
  note,
}: {
  poNumber: string | null;
  sizes: string[];
  eanStatus: string;
  href: string | null;
  note: string | null;
}) {
  const ean = eanStatusMeta(eanStatus);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-sm">
      <span className="min-w-[7.5rem] font-semibold tabular-nums text-zinc-800">
        {poNumber?.trim() || <span className="font-normal text-zinc-400">no PO</span>}
      </span>
      <span className="text-zinc-400">·</span>
      <span className="text-zinc-600" title={sizes.length > 0 ? sizes.join(", ") : undefined}>
        {sizeSummary(sizes)}
      </span>
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ean.cls}`}>
        {ean.label}
      </span>
      {/* Only shown for the weaker keys — an exact-name match needs no excuse,
          but a consignment-code hit must not masquerade as a certainty. */}
      {note && (
        <span className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800">
          {note}
        </span>
      )}
      <span className="ml-auto">
        {href ? (
          <Link
            href={href}
            className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            open
          </Link>
        ) : (
          <span className="rounded-md bg-amber-200/70 px-2.5 py-1 text-xs font-semibold text-amber-900">
            you are here
          </span>
        )}
      </span>
    </li>
  );
}

// Presentational only — pure over its props, no I/O. Pair it with
// loadRelatedRowsCardProps() below, or render RelatedRowsCardForStyle() which
// composes the two.
export function RelatedRowsCard({ current, related, className = "mt-4" }: RelatedRowsCardProps) {
  if (related.length === 0) return null;

  // Total rows in play, including the one being viewed — "2 rows share this
  // name" reads as the whole picture, where "1 other row" makes the reader do
  // the arithmetic.
  const total = related.length + 1;
  // Headline honesty: only claim "share this style name" when every match
  // really is an exact-name hit. A mixed or weaker set gets softer wording,
  // and each row carries its own reason.
  const allByName = related.every((r) => r.matchedOn === "name");
  const headline = allByName
    ? `${total} rows in Monday share this style name`
    : `${total} rows in Monday look like this style`;

  // One list, ordered by PO, with the current row folded in at its natural
  // position — so "you are here" lands inside the sequence rather than being
  // bolted on top of a list of other people's rows.
  const lines: Array<{
    key: string;
    poNumber: string | null;
    sizes: string[];
    eanStatus: string;
    // null href ⇒ this is the row being viewed ⇒ "you are here".
    href: string | null;
    // null note ⇒ exact-name match, which needs no justification.
    note: string | null;
  }> = [
    {
      key: current.id,
      poNumber: current.poNumber,
      sizes: current.sizes,
      eanStatus: current.eanStatus,
      href: null,
      note: null,
    },
    ...related.map((r) => ({
      key: r.id,
      poNumber: r.poNumber,
      sizes: r.sizes,
      eanStatus: r.eanStatus,
      href: `/styles/${r.id}`,
      note: r.matchedOn === "name" ? null : LOOKALIKE_MATCH_LABELS[r.matchedOn],
    })),
  ].sort((a, b) =>
    (a.poNumber ?? "").trim().toUpperCase().localeCompare((b.poNumber ?? "").trim().toUpperCase()),
  );

  return (
    <div className={`rounded-lg border border-amber-300 bg-amber-50 p-4 ${className}`}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <span aria-hidden>⚠</span>
        {headline}
      </h3>
      <p className="mt-1 text-xs text-amber-800">
        Each Purchase Order gets its own Monday row, and they can carry different
        parts of the size run. Check you are on the order you meant — nothing below
        is an error.
      </p>
      <ul className="mt-2 divide-y divide-amber-200/70">
        {lines.map((l) => (
          <Row
            key={l.key}
            poNumber={l.poNumber}
            sizes={l.sizes}
            eanStatus={l.eanStatus}
            href={l.href}
            note={l.note}
          />
        ))}
      </ul>
    </div>
  );
}

// Server-side loader. Returns null when there is nothing to say — no style, or
// no lookalikes — so a caller can `const p = await …; return p && <Card {...p} />`
// without knowing the rules.
export async function loadRelatedRowsCardProps(
  styleId: string,
): Promise<RelatedRowsCardProps | null> {
  const report = await loadLookalikes(styleId);
  if (!report || report.matches.length === 0) return null;
  return { current: report.subject, related: report.matches };
}

// Async server component that composes the loader and the card, so the style
// page can drop in one line and stay unaware of both. Use RelatedRowsCard +
// loadRelatedRowsCardProps directly if a caller needs the data for anything
// else (e.g. to decide layout before rendering).
export async function RelatedRowsCardForStyle({
  styleId,
  className,
}: {
  styleId: string;
  className?: string;
}) {
  const props = await loadRelatedRowsCardProps(styleId);
  if (!props) return null;
  return <RelatedRowsCard {...props} className={className} />;
}
