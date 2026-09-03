"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";
import { LazyOutputPreview } from "@/components/output-preview";
import { CoverRegenPanel } from "./cover-regen-panel";
import { StyleRegenPanel } from "./style-regen";

// Editor for ONE Prod Spec's "General information" — the pages that ship inside
// the cover PDF, after the cover sheet. A Prod Spec is a Customer × Business
// Area pair (unique on the row), so the picker here IS "client + business area".
//
// Saves through /api/admin/prod-specs/<id>/general-info — the narrow
// single-column endpoint — NOT the full ProdSpec PATCH the admin editor uses.
// That endpoint's comment has the why; the short version is that the full PATCH
// carries the whole config payload and auto-activates draft specs on save.

export type ProdSpecOption = {
  id: string;
  name: string;
  customerName: string;
  businessAreaName: string;
  hasGeneralInfo: boolean;
  active: boolean;
};

const AUTOSAVE_DEBOUNCE_MS = 800;

export function GeneralInfoEditor({ prodSpecs }: { prodSpecs: ProdSpecOption[] }) {
  const [selectedId, setSelectedId] = useState<string>(prodSpecs[0]?.id ?? "");

  const selected = useMemo(
    () => prodSpecs.find((p) => p.id === selectedId) ?? null,
    [prodSpecs, selectedId],
  );

  if (prodSpecs.length === 0) {
    return (
      <p className="mt-6 text-sm text-zinc-500">
        No prod specs exist yet — General information is written per client and business area, so
        there&apos;s nothing to edit until the first one is created.
      </p>
    );
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="gi-prod-spec" className="text-sm font-medium text-zinc-700">
          Client &amp; business area
        </label>
        <select
          id="gi-prod-spec"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="min-w-[22rem] rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
        >
          {prodSpecs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.customerName} · {p.businessAreaName}
              {p.hasGeneralInfo ? "" : " — empty"}
              {p.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </div>

      {/* Keyed on the spec so switching REMOUNTS the whole per-spec subtree.
          That's what guarantees no bleed between specs: the loaded markdown,
          the pending autosave debounce, the "Saved" stamp and the regen
          panel's prepared style-id list are all discarded with the old
          instance rather than reset by hand. */}
      {selected && <SpecGeneralInfo key={selected.id} prodSpec={selected} />}
    </div>
  );
}

type SaveState = "saving" | "saved" | "error";

function SpecGeneralInfo({ prodSpec }: { prodSpec: ProdSpecOption }) {
  // null until the GET lands — doubles as the "still loading" flag, so no
  // autosave can fire against an empty box and blank the column.
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timeoutRef = useRef<number | null>(null);
  const lastSavedRef = useRef<string | null>(null);

  // Load this spec's markdown once, on mount. Every setState sits inside the
  // async continuation (never the effect body), and `cancelled` covers the
  // unmount-before-response case.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/prod-specs/${prodSpec.id}/general-info`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Could not load (${res.status})`);
        }
        const data = (await res.json()) as { markdown: string };
        if (cancelled) return;
        lastSavedRef.current = data.markdown;
        setMarkdown(data.markdown);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load");
        setSaveState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prodSpec.id]);

  // Cancel a pending debounce on unmount. A save already in flight is left to
  // finish — its writes are guarded by the unmount, and the PATCH is a plain
  // single-column overwrite.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const save = useCallback(
    async (value: string) => {
      setSaveState("saving");
      setError(null);
      try {
        const res = await fetch(`/api/admin/prod-specs/${prodSpec.id}/general-info`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ markdown: value }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Save failed (${res.status})`);
        }
        lastSavedRef.current = value;
        setSaveState("saved");
        setSavedAt(new Date().toLocaleTimeString());
      } catch (e) {
        setSaveState("error");
        setError(e instanceof Error ? e.message : "Save failed");
      }
    },
    [prodSpec.id],
  );

  const onChange = useCallback(
    (value: string) => {
      setMarkdown(value);
      // Nothing loaded yet ⇒ this can only be the editor initialising itself.
      if (lastSavedRef.current === null) return;
      if (value === lastSavedRef.current) return;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => void save(value), AUTOSAVE_DEBOUNCE_MS);
    },
    [save],
  );

  const scopeLabel = `${prodSpec.customerName} · ${prodSpec.businessAreaName}`;
  const status =
    markdown === null && saveState !== "error"
      ? "Loading…"
      : saveState === "saving"
        ? "Saving…"
        : saveState === "error"
          ? (error ?? "Save failed")
          : savedAt
            ? `Saved · ${savedAt}`
            : "Auto-saves as you type";

  return (
    <>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700">Content</span>
            <span
              className={`text-xs ${saveState === "error" ? "text-red-600" : "text-zinc-400"}`}
              role="status"
            >
              {status}
            </span>
          </div>
          {markdown === null ? (
            <div className="h-64 animate-pulse rounded-md border border-zinc-200 bg-zinc-50" />
          ) : (
            <MarkdownEditor
              value={markdown}
              onChange={onChange}
              uploadUrl={`/api/admin/prod-specs/${prodSpec.id}/images`}
            />
          )}
          {/* Part of the save affordance, not a footnote — it states what
              saving does and does not do, at the moment of saving. Saving has
              always been future-only: the runner re-renders a cover only when a
              run produces >=1 output, and a fully-approved style settles
              without rendering, so existing covers keep the text they were
              built with. Nothing in the UI said so, and people reasonably read
              "Saved" as "published", then assumed suppliers were looking at the
              new wording. The behaviour is unchanged; only the silence is. The
              two panels below are the sentence's second half — one style
              (every order carrying its number), or the whole client. */}
          <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] leading-relaxed text-zinc-600">
            <strong className="font-medium text-zinc-800">
              Saving applies to bundles generated from now on.
            </strong>{" "}
            Bundles that already exist — including any already delivered to a supplier — keep the
            text they were generated with until you regenerate them. Use{" "}
            <em>Regenerate a style</em> below to correct one style across every order that carries
            its number, or <em>Apply to existing bundles</em> for every style under this client and
            business area.
          </p>
          <p className="text-[11px] text-zinc-400">
            These pages print inside the cover PDF, after the cover sheet — one set per client and
            business area. Type <code className="font-mono">#</code> + space for a heading,{" "}
            <code className="font-mono">-</code> + space for a list; tables and images insert from
            the toolbar. Preview refreshes after each autosave.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-zinc-700">General information preview</span>
          <div className="rounded-md bg-zinc-100 p-3">
            <LazyOutputPreview
              src={`/api/admin/prod-specs/${prodSpec.id}/general-info-preview`}
              widthMm={210}
              heightMm={297}
              refreshKey={savedAt ?? undefined}
            />
          </div>
        </div>
      </div>

      <StyleRegenPanel prodSpecId={prodSpec.id} scopeLabel={scopeLabel} />
      <CoverRegenPanel prodSpecId={prodSpec.id} scopeLabel={scopeLabel} />
    </>
  );
}
