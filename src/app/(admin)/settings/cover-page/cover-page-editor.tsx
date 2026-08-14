"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { announceCoverContentSaved } from "./cover-content-events";
import { MarkdownEditor } from "@/components/markdown-editor";
import { LazyOutputPreview } from "@/components/output-preview";

// Editor for the GLOBAL cover-page content block. Autosaves the markdown to
// /api/admin/settings/cover-page (debounced), then bumps the preview so the A4
// iframe refetches — mirrors the ProdSpec General-information editor. Images
// upload to the global cover-image store and are referenced by serve URL.
type SaveState = "idle" | "saving" | "saved" | "error";

export function CoverPageEditor({ initialMarkdown }: { initialMarkdown: string }) {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  // The last value we successfully persisted — so an unchanged edit (e.g. the
  // editor re-emitting identical markdown) doesn't trigger a needless save.
  const lastSavedRef = useRef(initialMarkdown);

  const save = useCallback(async (value: string) => {
    setSaveState("saving");
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/cover-page", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: value }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; contentChanged?: boolean }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Save failed (${res.status})`);
      // The server tells us whether this actually changed the stored prose —
      // the debounce re-sends identical markdown routinely, and announcing
      // those would leave the stale banner permanently up.
      if (body?.contentChanged) announceCoverContentSaved();
      lastSavedRef.current = value;
      setSaveState("saved");
      // Bump the preview refresh key so the A4 iframe refetches the saved copy.
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }, []);

  const onChange = useCallback(
    (value: string) => {
      setMarkdown(value);
      if (value === lastSavedRef.current) return;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => void save(value), 800);
    },
    [save],
  );

  // Flush a pending debounce on unmount so a quick edit-then-navigate persists.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const status =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? error ?? "Save failed"
        : savedAt
          ? `Saved · ${savedAt}`
          : "Auto-saves as you type";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
        <MarkdownEditor
          value={markdown}
          onChange={onChange}
          uploadUrl="/api/admin/settings/cover-page/images"
        />
        <p className="text-[11px] text-zinc-400">
          Type <code className="font-mono">#</code> + space for a heading,{" "}
          <code className="font-mono">-</code> + space for a list; tables and images insert from the
          toolbar. Keep it short — it sits on the cover sheet, so long content is better placed in a
          Prod Spec&apos;s General information. Preview refreshes after each autosave.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-zinc-700">Cover preview (sample)</span>
        <div className="rounded-md bg-zinc-100 p-3">
          <LazyOutputPreview
            src="/api/admin/settings/cover-page/preview"
            widthMm={210}
            heightMm={297}
            refreshKey={savedAt ?? undefined}
          />
        </div>
      </div>
    </div>
  );
}
