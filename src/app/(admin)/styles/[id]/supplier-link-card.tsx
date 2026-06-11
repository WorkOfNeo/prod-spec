"use client";

import { useState } from "react";

export type SupplierShareInfo = {
  url: string;
  pin: string;
  email: string;
  visitCount: number;
  firstVisitedAt: string | null;
  lastVisitedAt: string | null;
};

function fmt(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Supplier-link panel on the prod-spec tab: the durable link + PIN to
// (re)send, and whether the supplier has opened it. The link always serves
// the latest approved version, so there's no staleness to warn about.
export function SupplierLinkCard({ share }: { share: SupplierShareInfo }) {
  const opened = share.visitCount > 0;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700">Supplier link</h3>
        {opened ? (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
            ✓ Opened · {share.visitCount} view{share.visitCount === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500">
            Not opened yet
          </span>
        )}
      </div>

      <p className="mt-1 text-xs text-zinc-500">
        {share.email ? (
          <>
            Sent to <span className="font-medium text-zinc-700">{share.email}</span>. They unlock it with
            that email + the PIN.
          </>
        ) : (
          <span className="text-amber-700">
            No supplier email resolved — forward this link and PIN manually. The recipient enters the
            email it should be gated to… set a supplier email and re-approve to lock it down.
          </span>
        )}
      </p>

      {opened ? (
        <p className="mt-1 text-xs text-emerald-700">
          First opened {fmt(share.firstVisitedAt)}
          {share.lastVisitedAt && share.lastVisitedAt !== share.firstVisitedAt
            ? ` · last ${fmt(share.lastVisitedAt)}`
            : ""}
        </p>
      ) : null}

      <p className="mt-1 text-xs text-zinc-400">
        Durable link — always shows the latest approved version of each output.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <CopyRow label="Link" value={share.url} mono href={share.url} />
        <CopyRow label="PIN" value={share.pin} mono big />
      </div>
    </div>
  );
}

function CopyRow({
  label,
  value,
  mono,
  big,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  big?: boolean;
  href?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context) — selection still works.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-xs text-zinc-400">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-zinc-700 ${
          mono ? "font-mono" : ""
        } ${big ? "text-base tracking-[0.3em]" : "text-xs"}`}
        title={value}
      >
        {value}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-50"
        >
          Open
        </a>
      ) : null}
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-50"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
