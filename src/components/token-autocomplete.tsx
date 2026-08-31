"use client";

// =====================================================
// Token autofill — a fuzzy typeahead that pops up while you type a
// {{variable}} inside the Output Builder content editor. Type "{{" and the
// full list appears; keep typing ("{{made") and it fuzzy-filters to the
// related variables ({{madeIn:da}}, {{madeInLabel:da}}, …).
//
//   ↑ / ↓   move the highlight
//   ↵ / ⇥   insert the highlighted variable at the cursor
//   esc     dismiss (keeps typing)
//   mouse   hover to highlight, click to insert
//
// The card is two columns: ranked results on the left under sticky group
// headings, and the highlighted token explained in full on the right — its
// label, what it resolves to for the previewed style, and the same field's
// other arguments as one-click swaps. Nothing in it truncates; that pane
// exists so ":inner" and ":outer" are told apart without a second search.
//
// It renders the <textarea> itself (forwarding the ref so the surrounding
// editor's cursor helpers keep working) plus a floating results card
// positioned at the caret. Self-contained: no external autocomplete lib.
// =====================================================

import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LAYOUT_TOKENS,
  SIBLING_FIELDS,
  BARCODE_SOURCES,
  LOGO_SOURCES,
  CERT_SOURCES,
  SIZE_SCOPE_ARG,
  SIZE_FORMS,
  TABLE_TOTAL_ARG,
} from "@/lib/output-layouts/token-meta";
import { CARTON_QTY_KINDS } from "@/lib/output-layouts/carton-qty";

export type TokenSuggestion = {
  // The exact text inserted at the cursor, e.g. "{{madeIn:da}}".
  insert: string;
  // Human label shown to the right of the token.
  label: string;
  // Group name (shown as a small tag) — mirrors the palette sections.
  group: string;
  // Optional example/preview value, shown muted.
  hint?: string;
};

// The full insertable catalogue, built for the current language + sibling
// slot so the ":lang" and "styleN…" tokens insert the right variant. Mirrors
// the right-rail palette so both surfaces stay in lockstep.
export function buildTokenSuggestions(opts: {
  langSel: string;
  siblingSlot: number;
  // Active rows of the image library — {{image:<slug>}} has no fixed source
  // list, so the catalogue is only as complete as what the caller passes.
  images?: Array<{ slug: string; name: string }>;
}): TokenSuggestion[] {
  const { langSel, siblingSlot, images = [] } = opts;
  const out: TokenSuggestion[] = [];

  for (const t of LAYOUT_TOKENS) {
    if (t.arg === "imageSlug") {
      // One entry per picture in the library, so typing "{{" then the
      // picture's name finds it the same way a fixed token does.
      for (const img of images) {
        out.push({
          insert: `{{${t.key}:${img.slug}}}`,
          label: `Image · ${img.name}`,
          group: t.group,
          hint: "Settings → Images",
        });
      }
    } else if (t.arg === "source") {
      const sources =
        t.key === "barcode"
          ? BARCODE_SOURCES
          : t.key === "logo"
            ? LOGO_SOURCES
            : t.key === "cert"
              ? CERT_SOURCES
              : [];
      for (const src of sources) {
        out.push({
          insert: `{{${t.key}:${src}}}`,
          label: `${t.label} · ${src}`,
          group: t.group,
          hint: t.example,
        });
      }
    } else if (t.arg === "lang") {
      out.push({
        insert: `{{${t.key}:${langSel}}}`,
        label: t.label,
        group: t.group,
        hint: t.example,
      });
    } else if (t.arg === "cartonKind") {
      // Bare (the plain value) plus the split selectors.
      out.push({ insert: `{{${t.key}}}`, label: t.label, group: t.group, hint: t.example });
      for (const kind of CARTON_QTY_KINDS) {
        out.push({
          insert: `{{${t.key}:${kind}}}`,
          label: `${t.label} · ${kind}`,
          group: t.group,
          hint: t.example,
        });
      }
    } else if (t.arg === "sizeScope") {
      // Bare (the whole value) plus the per-size selector.
      out.push({ insert: `{{${t.key}}}`, label: t.label, group: t.group, hint: t.example });
      out.push({
        insert: `{{${t.key}:${SIZE_SCOPE_ARG}}}`,
        label: `${t.label} · this size only`,
        group: t.group,
        hint: t.example,
      });
    } else if (t.arg === "tableTotal") {
      // Bare (the table alone) plus the same table with the pack total in
      // its bottom-right corner.
      out.push({ insert: `{{${t.key}}}`, label: t.label, group: t.group, hint: t.example });
      out.push({
        insert: `{{${t.key}:${TABLE_TOTAL_ARG}}}`,
        label: `${t.label} · with total`,
        group: t.group,
        hint: t.example,
      });
    } else if (t.arg === "sizeForm") {
      // Bare (the label as authored) plus the two halves of a two-form
      // size label — "86-92 cm / 1½-2 år" as centimetres or as age.
      out.push({ insert: `{{${t.key}}}`, label: t.label, group: t.group, hint: t.example });
      for (const form of SIZE_FORMS) {
        out.push({
          insert: `{{${t.key}:${form}}}`,
          label: `${t.label} · ${form === "year" ? "age only" : "measurement only"}`,
          group: t.group,
          hint: t.example,
        });
      }
    } else {
      // Plain tokens and the optional-gap wash symbols insert bare.
      out.push({ insert: `{{${t.key}}}`, label: t.label, group: t.group, hint: t.example });
    }
  }

  // Sibling-style slot fields ({{style2}}, {{style2Name}}…) for the slot the
  // palette is currently pointed at.
  for (const f of SIBLING_FIELDS) {
    const key = `style${siblingSlot}${f.suffix}`;
    out.push({
      insert: `{{${key}}}`,
      label: `Style ${siblingSlot} · ${f.label}`,
      group: "Sibling styles",
    });
  }

  // Calculated values.
  out.push({
    insert: "{{= sum(qtyPerCarton) }}",
    label: "Sum qty per carton (carton total)",
    group: "Calculated",
  });
  out.push({
    insert: "{{= count(styleNumber) }}",
    label: "Count styles on the carton",
    group: "Calculated",
  });
  out.push({
    insert: "{{= }}",
    label: "Calculation — write your own expression",
    group: "Calculated",
  });

  // Logic / control flow.
  out.push({
    insert: "{{if FIELD == VALUE}}{{else}}{{endif}}",
    label: "if / else / endif — conditional (==, !=)",
    group: "Logic",
  });
  out.push({
    insert: "{{if productGroup contains Set}}PER SÆT{{else}}KR.{{endif}}",
    label: "if contains — the field mentions a word (Set / Gift Set / SET 2-PACK)",
    group: "Logic",
  });
  out.push({
    insert: "{{if FIELD includes VALUE}}{{endif}}",
    label: "if includes — list condition",
    group: "Logic",
  });
  out.push({ insert: "{{else}}", label: "else", group: "Logic" });
  out.push({ insert: "{{endif}}", label: "endif", group: "Logic" });

  return out;
}

// ---- fuzzy matching ---------------------------------------------------

// Subsequence fuzzy scorer. Returns null when `query` isn't a subsequence of
// `target`; otherwise a score (higher = better) plus the matched indices in
// `target` (for highlighting). Word boundaries (start, after :/-/space, and
// camelCase humps) and contiguous runs score higher — so "made" ranks
// {{madeIn}} above an incidental m…a…d…e scattered through a long label.
function fuzzyMatch(
  query: string,
  target: string,
): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const tl = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let run = 0;
  let prev = -2;
  for (let ti = 0; ti < tl.length && qi < q.length; ti++) {
    if (tl[ti] !== q[qi]) continue;
    const boundary =
      ti === 0 ||
      /[^a-z0-9]/i.test(target[ti - 1]) ||
      (/[a-z]/.test(target[ti - 1]) && /[A-Z]/.test(target[ti])); // camelCase hump
    run = ti === prev + 1 ? run + 1 : 0;
    score += 1 + run * 3 + (boundary ? 6 : 0) + (ti === 0 ? 4 : 0);
    positions.push(ti);
    prev = ti;
    qi++;
  }
  if (qi < q.length) return null; // not every query char matched
  // Prefer tighter matches (less slack) that start earlier.
  score -= (target.length - q.length) * 0.1;
  score -= positions[0] * 0.2;
  return { score, positions };
}

// Score a suggestion across its token, label and group. Highlight positions
// track the TOKEN string (what the row shows in mono) so the emphasis lands
// on the thing that gets inserted.
function scoreSuggestion(
  query: string,
  s: TokenSuggestion,
): { score: number; positions: number[] } | null {
  const onToken = fuzzyMatch(query, s.insert);
  const onLabel = fuzzyMatch(query, s.label);
  const onGroup = fuzzyMatch(query, s.group);
  const scores = [
    onToken ? onToken.score + 6 : null, // a hit in the token itself wins
    onLabel ? onLabel.score : null,
    onGroup ? onGroup.score - 3 : null,
  ].filter((n): n is number => n !== null);
  if (scores.length === 0) return null;
  return { score: Math.max(...scores), positions: onToken?.positions ?? [] };
}

// ---- caret geometry ---------------------------------------------------

// Find the {{…}} the caret is currently typing inside. Returns the index of
// the opening "{{" and the raw text between it and the caret, or null when
// the caret isn't inside an open token (already closed with }}, a newline in
// between, …).
function detectOpenToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open === -1) return null;
  const between = value.slice(open + 2, caret);
  if (/[}\n]/.test(between)) return null; // closed, or spilled to the next line
  return { start: open, query: between };
}

// Style props copied onto the mirror element so it wraps text exactly like
// the textarea. Borders are handled separately (see caretCoordinates).
const MIRROR_PROPS = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "textTransform",
  "textIndent",
  "textAlign",
  "wordSpacing",
  "lineHeight",
  "tabSize",
] as const;

// Pixel position of a caret index inside a textarea, relative to the
// textarea's own border box. Uses the classic hidden-mirror technique: a div
// styled like the textarea, filled with the text up to the caret and a span
// marking the caret, then measured.
function caretCoordinates(
  el: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; height: number } {
  const doc = el.ownerDocument;
  const computed = window.getComputedStyle(el);
  const div = doc.createElement("div");
  const style = div.style as unknown as Record<string, string>;
  const c = computed as unknown as Record<string, string>;

  style.position = "absolute";
  style.visibility = "hidden";
  style.top = "0px";
  style.left = "0px";
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  style.overflow = "hidden";
  style.boxSizing = "content-box";
  for (const p of MIRROR_PROPS) style[p] = c[p];
  // Match the wrap width: clientWidth is the content box + padding, so strip
  // the horizontal padding back out for a content-box mirror.
  const padX =
    parseFloat(computed.paddingLeft || "0") + parseFloat(computed.paddingRight || "0");
  style.width = `${Math.max(0, el.clientWidth - padX)}px`;

  div.textContent = el.value.slice(0, position);
  const span = doc.createElement("span");
  span.textContent = el.value.slice(position) || "."; // non-empty → measurable
  div.appendChild(span);
  doc.body.appendChild(div);

  const borderTop = parseFloat(computed.borderTopWidth || "0");
  const borderLeft = parseFloat(computed.borderLeftWidth || "0");
  const lineHeight = parseFloat(computed.lineHeight);
  const top = span.offsetTop + borderTop;
  const left = span.offsetLeft + borderLeft;
  const height = Number.isFinite(lineHeight) ? lineHeight : span.offsetHeight;
  doc.body.removeChild(div);
  return { top, left, height };
}

// ---- detail pane helpers ----------------------------------------------

// The strict "plain token" shape — {{key}} or {{key:arg}} / {{key:arg:2}}.
// Logic and calculation snippets ({{if …}}, {{= sum(x) }}) carry spaces and
// operators, so they fall out here and get no value / variant lookup.
const PLAIN_TOKEN_RE = /^\{\{([A-Za-z][A-Za-z0-9]*)((?::[A-Za-z0-9]+)*)\}\}$/;

// "{{qtyPerCarton:outer}}" → "qtyPerCarton:outer" — the key the preview
// endpoint reports resolved values under. Null for anything non-plain.
function valueKey(insert: string): string | null {
  const m = PLAIN_TOKEN_RE.exec(insert);
  return m ? `${m[1]}${m[2]}` : null;
}

// "{{qtyPerCarton:outer}}" → "qtyPerCarton" — the family a token belongs to,
// so the detail pane can offer its sibling arguments as one-click swaps.
function tokenBase(insert: string): string | null {
  const m = PLAIN_TOKEN_RE.exec(insert);
  return m ? m[1] : null;
}

// ---- component --------------------------------------------------------

// The card is a two-column reader: results on the left, the highlighted
// token explained in full on the right. Below this width the detail pane
// stacks under the list instead of sitting beside it.
const DROPDOWN_W = 560;
const NARROW_BELOW = 480;
const LIST_MAX_H = 288;
// Worst case (list + footer, or stacked list + detail) — flip math only.
const DROPDOWN_MAX_H = 340;
// Ranked results are capped; the footer says so when the cap bites.
const MAX_ITEMS = 50;

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  suggestions: TokenSuggestion[];
  rows?: number;
  spellCheck?: boolean;
  className?: string;
  placeholder?: string;
  // Resolved values for the previewed test style, keyed exactly as the
  // variables palette keys them ("qtyPerCarton:outer", "barcode:ean13").
  // Optional: without it the detail pane simply omits the "resolves to" row.
  values?: Record<string, string>;
  // Name of the style those values came from, for the caption.
  valuesFrom?: string;
};

export const TokenAutocomplete = forwardRef<HTMLTextAreaElement, Props>(
  function TokenAutocomplete(
    {
      value,
      onValueChange,
      suggestions,
      rows,
      spellCheck,
      className,
      placeholder,
      values,
      valuesFrom,
    },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [start, setStart] = useState(0);
    const [active, setActive] = useState(0);
    const [pos, setPos] = useState<{
      left: number;
      top: number;
      flip: boolean;
      width: number;
      narrow: boolean;
    } | null>(null);

    // Caret to restore after a controlled-value update lands (React re-renders
    // the textarea from `value`, blowing away the native caret).
    const pendingCaretRef = useRef<number | null>(null);
    // The {start,query} the user dismissed with Esc — suppresses reopening
    // until they type something different.
    const dismissedRef = useRef<{ start: number; query: string } | null>(null);
    const prevQueryRef = useRef<string>("");

    // Ranked matches, then clustered under their group so the list carries one
    // sticky heading per group instead of a chip on every row. Groups are
    // ordered by their best-scoring member, so the top match stays first
    // overall — clustering re-orders the tail, never the winner.
    const { items, total } = useMemo(() => {
      if (!open) return { items: [] as Array<TokenSuggestion & { positions: number[] }>, total: 0 };
      const scored: Array<{ s: TokenSuggestion; score: number; positions: number[] }> = [];
      for (const s of suggestions) {
        const m = scoreSuggestion(query, s);
        if (m) scored.push({ s, score: m.score, positions: m.positions });
      }
      // Stable-ish: score desc, then shorter token, then alpha.
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          a.s.insert.length - b.s.insert.length ||
          a.s.insert.localeCompare(b.s.insert),
      );
      const top = scored.slice(0, MAX_ITEMS);
      const order: string[] = [];
      const byGroup = new Map<string, typeof top>();
      for (const x of top) {
        let bucket = byGroup.get(x.s.group);
        if (!bucket) {
          bucket = [];
          byGroup.set(x.s.group, bucket);
          order.push(x.s.group);
        }
        bucket.push(x);
      }
      return {
        items: order.flatMap((g) =>
          (byGroup.get(g) ?? []).map((x) => ({ ...x.s, positions: x.positions })),
        ),
        total: scored.length,
      };
    }, [open, query, suggestions]);

    const activeIdx = items.length ? Math.max(0, Math.min(active, items.length - 1)) : 0;
    const activeItem = items[activeIdx];

    // Sibling arguments of the highlighted token — {{qtyPerCarton}} offers
    // :solid / :assort / :inner / :outer, so the pane shows what else the
    // same field can print without a second search.
    const variants = useMemo(() => {
      if (!activeItem) return [] as TokenSuggestion[];
      const base = tokenBase(activeItem.insert);
      if (!base) return [];
      return suggestions
        .filter((s) => tokenBase(s.insert) === base && s.insert !== activeItem.insert)
        .slice(0, 8);
    }, [activeItem, suggestions]);

    const activeValue = activeItem ? values?.[valueKey(activeItem.insert) ?? ""] : undefined;

    // Re-detect the open token from the live DOM and reposition the card.
    const sync = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? 0;
      const det = detectOpenToken(el.value, caret);
      if (!det) {
        setOpen(false);
        dismissedRef.current = null;
        return;
      }
      const dismissed = dismissedRef.current;
      if (dismissed && dismissed.start === det.start && dismissed.query === det.query) {
        setOpen(false);
        return;
      }
      dismissedRef.current = null;

      const coords = caretCoordinates(el, det.start);
      const rect = el.getBoundingClientRect();
      // Fit the two-column card in the viewport; fall back to the single
      // column when even the narrow card would overflow.
      const width = Math.min(DROPDOWN_W, window.innerWidth - 16);
      const narrow = width < NARROW_BELOW;
      const left = Math.max(8, Math.min(rect.left + coords.left - el.scrollLeft, window.innerWidth - width - 8));
      const caretY = rect.top + coords.top - el.scrollTop;
      const belowY = caretY + coords.height + 6;
      const flip = belowY + DROPDOWN_MAX_H > window.innerHeight && caretY - 6 > DROPDOWN_MAX_H;
      const top = flip ? caretY - 6 : belowY;

      if (det.query !== prevQueryRef.current) setActive(0);
      prevQueryRef.current = det.query;
      setStart(det.start);
      setQuery(det.query);
      setPos({ left, top, flip, width, narrow });
      setOpen(true);
    }, []);

    // Restore the caret once the new value has been painted.
    useLayoutEffect(() => {
      const c = pendingCaretRef.current;
      if (c == null) return;
      pendingCaretRef.current = null;
      const el = innerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(c, c);
    }, [value]);

    // Keep the highlighted row in view while arrowing.
    const listRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (!open) return;
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }, [open, activeIdx]);

    // Reposition (or close) on scroll/resize while the card is open.
    useEffect(() => {
      if (!open) return;
      const onMove = () => sync();
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
      return () => {
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      };
    }, [open, sync]);

    function apply(item: TokenSuggestion) {
      const el = innerRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? 0;
      const det = detectOpenToken(el.value, caret);
      const from = det ? det.start : caret;
      // Swallow an existing closing "}}" right after the caret so we don't
      // leave "{{madeIn:da}}}}".
      const to = el.value.slice(caret, caret + 2) === "}}" ? caret + 2 : caret;
      const next = el.value.slice(0, from) + item.insert + el.value.slice(to);
      pendingCaretRef.current = from + item.insert.length;
      dismissedRef.current = null;
      setOpen(false);
      onValueChange(next);
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        dismissedRef.current = { start, query };
        setOpen(false);
        return;
      }
      if (items.length === 0) return; // nothing to drive — let keys through
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (Math.min(a, items.length - 1) + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (Math.min(a, items.length - 1) + items.length - 1) % items.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        apply(items[activeIdx]);
      }
    }

    // Navigation keys are handled in keydown; skip their keyup so we don't
    // thrash the position for a caret that didn't move.
    const NAV = new Set(["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]);
    function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (NAV.has(e.key)) return;
      sync();
    }

    return (
      <div className="relative">
        <textarea
          ref={setRefs}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
            // Let the change land, then re-detect from fresh DOM state.
            requestAnimationFrame(sync);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onClick={sync}
          onFocus={sync}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          rows={rows}
          spellCheck={spellCheck}
          placeholder={placeholder}
          className={className}
        />

        {open && pos ? (
          <div
            className="fixed z-50 grid overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl"
            style={{
              left: pos.left,
              top: pos.top,
              width: pos.width,
              gridTemplateColumns: pos.narrow ? "minmax(0,1fr)" : "minmax(0,1.05fr) minmax(0,1fr)",
              transform: pos.flip ? "translateY(-100%)" : undefined,
            }}
            // Keep focus in the textarea when interacting with the card.
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.length === 0 ? (
              <div className="px-3 py-2.5 text-xs text-zinc-400" style={{ gridColumn: "1 / -1" }}>
                No variables match <span className="font-mono text-zinc-500">{query}</span>
              </div>
            ) : (
              <>
                <div
                  ref={listRef}
                  role="listbox"
                  aria-label="Variables"
                  className={`overflow-y-auto pb-1 ${pos.narrow ? "" : "border-r border-zinc-100"}`}
                  style={{ maxHeight: LIST_MAX_H }}
                >
                  {items.map((it, i) => (
                    <Fragment key={`${it.insert}-${i}`}>
                      {i === 0 || items[i - 1].group !== it.group ? (
                        <div className="sticky top-0 z-10 border-b border-zinc-100 bg-zinc-50 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                          {it.group}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        data-idx={i}
                        role="option"
                        aria-selected={i === activeIdx}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => apply(it)}
                        className={`flex w-full flex-col gap-px px-2.5 py-1.5 text-left ${
                          i === activeIdx ? "bg-zinc-100" : "hover:bg-zinc-50"
                        }`}
                      >
                        {/* The token wraps rather than truncating — the whole
                            point is being able to read which argument this is. */}
                        <span className="block break-all font-mono text-[12px] leading-snug text-zinc-800">
                          <Highlighted text={it.insert} positions={it.positions} />
                        </span>
                        <span className="line-clamp-2 block text-[11px] leading-snug text-zinc-400">
                          {it.label}
                        </span>
                      </button>
                    </Fragment>
                  ))}
                </div>

                {/* Detail pane — the highlighted token, in full. */}
                <div
                  className={`flex flex-col overflow-y-auto ${pos.narrow ? "border-t border-zinc-100" : ""}`}
                  style={{ maxHeight: LIST_MAX_H }}
                >
                  {activeItem ? (
                    <div className="flex flex-col gap-2.5 px-3 py-2.5">
                      <div className="break-all font-mono text-[12.5px] leading-snug text-zinc-900">
                        {activeItem.insert}
                      </div>
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                          {activeItem.group}
                        </div>
                        <p className="mt-0.5 text-[11.5px] leading-snug text-zinc-600">{activeItem.label}</p>
                      </div>
                      {activeValue !== undefined && activeValue !== "" ? (
                        <div className="rounded bg-emerald-50 px-2 py-1.5">
                          <div className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700">
                            Resolves to{valuesFrom ? ` · ${valuesFrom}` : ""}
                          </div>
                          <div className="mt-0.5 break-words font-mono text-[11.5px] leading-snug text-zinc-800">
                            {activeValue}
                          </div>
                        </div>
                      ) : activeItem.hint ? (
                        <div className="rounded bg-zinc-50 px-2 py-1.5">
                          <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                            Example
                          </div>
                          <div className="mt-0.5 break-words font-mono text-[11.5px] leading-snug text-zinc-600">
                            {activeItem.hint}
                          </div>
                        </div>
                      ) : null}
                      {variants.length > 0 ? (
                        <div>
                          <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                            Same field, other arguments
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {variants.map((v) => (
                              <button
                                key={v.insert}
                                type="button"
                                title={v.label}
                                onClick={() => apply(v)}
                                className="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
                              >
                                {v.insert.replace(/^\{\{|\}\}$/g, "")}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </>
            )}

            <div
              className="flex items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50/70 px-2.5 py-1 text-[10px] text-zinc-400"
              style={{ gridColumn: "1 / -1" }}
            >
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> insert · <Kbd>esc</Kbd> close
              </span>
              {items.length > 0 ? (
                <span className="tabular-nums">
                  {total > items.length
                    ? `${items.length} of ${total} — keep typing`
                    : `${total} match${total === 1 ? "" : "es"}`}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-px inline-block rounded border border-zinc-200 bg-white px-1 font-sans text-[9px] text-zinc-500">
      {children}
    </kbd>
  );
}

// Bold the fuzzy-matched characters within the token string.
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const hit = new Set(positions);
  const runs: Array<{ text: string; on: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const on = hit.has(i);
    const last = runs[runs.length - 1];
    if (last && last.on === on) last.text += text[i];
    else runs.push({ text: text[i], on });
  }
  return (
    <>
      {runs.map((r, i) =>
        r.on ? (
          <span key={i} className="font-semibold text-zinc-950">
            {r.text}
          </span>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}
