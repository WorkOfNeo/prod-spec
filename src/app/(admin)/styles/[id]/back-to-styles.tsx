"use client";

// The style page's back link. Returns the reviewer to the LIST THEY CAME FROM
// — the PO they searched, with their filters intact — instead of dumping them
// on the unfiltered ~4k-row table and making them search the same PO again for
// the next style on that order.
//
// The filter is stashed by the styles table (sessionStorage, see
// @/lib/styles/back-link); when there's nothing stashed — deep link, new tab,
// a link from Reviews — it falls back to this style's own PO number as the
// search, so Back still lands on that PO.
//
// sessionStorage is an external store, read through useSyncExternalStore: the
// server snapshot is null (so SSR renders the PO fallback and hydration
// matches), and the client snapshot is the stashed filter.

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { STYLES_FILTER_KEY, stylesBackHref, stylesBackLabel } from "@/lib/styles/back-link";
import { ChevronLeft } from "lucide-react";

// Nothing writes the key while a style page is open (the table lives on another
// route), so there is nothing to subscribe to — the unsubscribe is a no-op.
const subscribe = () => () => {};

function readStash(): string | null {
  try {
    return window.sessionStorage.getItem(STYLES_FILTER_KEY);
  } catch {
    // Private mode / disabled storage — keep the PO fallback.
    return null;
  }
}

export function BackToStyles({
  poNumber,
  variant = "link",
}: {
  poNumber: string | null;
  // "crumb": the page header's "Styles /" breadcrumb — same destination, the
  // list's name as the label (the full label moves to the tooltip).
  variant?: "link" | "crumb";
}) {
  const stashed = useSyncExternalStore(subscribe, readStash, () => null);

  if (variant === "crumb") {
    return (
      <Link
        href={stylesBackHref(stashed, poNumber)}
        className="text-muted hover:text-ink shrink-0 text-[14px]"
        title={stylesBackLabel(stashed, poNumber)}
      >
        Styles
      </Link>
    );
  }

  return (
    <Link
      href={stylesBackHref(stashed, poNumber)}
      className="text-muted hover:text-ink -ml-1 inline-flex items-center gap-0.5 rounded px-1 text-[12px]"
      title="Back to the styles list you came from"
    >
      <ChevronLeft size={14} aria-hidden="true" />
      {stylesBackLabel(stashed, poNumber)}
    </Link>
  );
}
