import type { ReactNode } from "react";
import type { LineEditNote } from "@/lib/outputs/line-edit-notes";
import { formatDate } from "@/lib/utils";

// The "edited by hand" note on a Review-tab card. A reviewer's "Edit any line"
// rewrite is stored per style — not in Monday, not in the layout — so without
// this a label that prints differently from its sibling gives no clue why.
// Shows, per edited line: who and when, what the layout says, what the edit
// says (with long space runs made visible — padding is invisible on a label
// but is exactly what a stray gap is made of), what it prints, and a warning
// for any token the edit added that prints nothing on this style.
//
// Presentational only (no hooks), so both the server-rendered tab and the
// client-side DeliveredCard can render it.

// The notes that apply to one card. A card for "<base>#<suffix>" (one PDF of a
// split output) gets the whole-output edits plus its own; a card for the base
// key is the output's only document, so every edit of that output applies.
export function lineEditsForCard(notes: readonly LineEditNote[], variantKey: string | null): LineEditNote[] {
  if (!variantKey) return [];
  const at = variantKey.indexOf("#");
  const baseKey = at >= 0 ? variantKey.slice(0, at) : variantKey;
  return notes.filter(
    (n) => n.baseKey === baseKey && (at < 0 || n.documentSuffix == null || n.variantKey === variantKey),
  );
}

// Runs of 2+ spaces become a visible "␣×N" chip — collapsed HTML whitespace
// would otherwise hide the very thing that makes a label look broken.
function showSpaces(text: string): ReactNode[] {
  return text.split(/( {2,})/).map((part, i) =>
    / {2,}/.test(part) ? (
      <span
        key={i}
        title={`${part.length} spaces`}
        className="mx-0.5 rounded bg-amber-200/80 px-1 font-sans text-[10px] text-amber-900"
      >
        ␣×{part.length}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-1 flex gap-1.5">
      <span className="w-11 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 break-words font-mono text-[10px] leading-4 text-zinc-800">{children}</span>
    </div>
  );
}

export function LineEditsNote({ notes }: { notes: readonly LineEditNote[] }) {
  if (notes.length === 0) return null;
  const flagged = notes.some((n) => n.emptyTokens.length > 0);
  return (
    <div
      data-testid="line-edits-note"
      className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${
        flagged ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className={`font-semibold ${flagged ? "text-red-800" : "text-amber-900"}`}>
        ✎ {notes.length} line{notes.length === 1 ? "" : "s"} edited by hand
      </div>
      {notes.map((n) => {
        const unchanged = n.authored != null && n.authored === n.value;
        return (
          <div key={n.id} className="mt-1.5 border-t border-black/5 pt-1.5">
            <div className="text-[10px] text-zinc-600">
              <b>{n.editedByName ?? "Unknown user"}</b> ·{" "}
              <span suppressHydrationWarning>{formatDate(n.editedAt)}</span> ·{" "}
              {n.documentSuffix ? `only ${n.documentSuffix}` : "all PDFs"}
              {unchanged ? <span className="text-zinc-400"> · same text as the layout</span> : null}
            </div>
            {!unchanged ? (
              <Row label="Layout">
                {n.authored == null ? (
                  <span className="font-sans italic text-zinc-400">line no longer in the layout</span>
                ) : n.authored === "" ? (
                  <span className="font-sans italic text-zinc-400">empty line</span>
                ) : (
                  showSpaces(n.authored)
                )}
              </Row>
            ) : null}
            <Row label="Edited">{showSpaces(n.value)}</Row>
            {n.printed != null ? (
              <Row label="Prints">
                {n.printed ? showSpaces(n.printed) : <span className="font-sans italic text-zinc-400">nothing</span>}
              </Row>
            ) : null}
            {n.emptyTokens.length > 0 ? (
              <div className="mt-1 rounded bg-red-100 px-1.5 py-1 text-[10px] leading-4 text-red-800">
                ⚠ <span className="font-mono">{n.emptyTokens.join(" ")}</span>{" "}
                {n.emptyTokens.length === 1 ? "prints" : "print"} nothing on this style — only the text around{" "}
                {n.emptyTokens.length === 1 ? "it" : "them"} shows.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
