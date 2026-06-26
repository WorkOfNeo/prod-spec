"use client";

import { useEffect, useRef, useState } from "react";
import { Combobox } from "@/components/ui/combobox";

// =====================================================
// "Test" tab — a dry run of the generation runner.
//
// Pick a real style linked to this prod spec, click Generate, and the
// server renders the cover (general information rides inside it) plus
// every enabled output to REAL PDFs — the exact documents an actual
// rerun would produce — WITHOUT creating a job, persisting assets, or
// notifying reviewers. Each PDF embeds inline with a download link so the
// operator can eyeball the whole bundle before committing to a rerun.
// =====================================================

export type TestStyle = {
  id: string;
  name: string;
  poNumber: string | null;
  status: string;
  completionPct: number;
};

type TestDoc = {
  kind: "cover" | "general-info" | "output";
  variantKey: string;
  name: string;
  fileName: string | null;
  widthMm: number;
  heightMm: number;
  staticPdf: boolean;
  placeholderCount: number;
  error: string | null;
  pdfBase64: string | null;
};

type TestResult = {
  style: { id: string; name: string; styleNumber: string; poNumber: string | null };
  warnings: string[];
  docs: TestDoc[];
};

// A doc paired with its created Blob URL (revoked when results change).
type RenderedDoc = TestDoc & { blobUrl: string | null };

type Phase =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "done"; style: TestResult["style"]; warnings: string[]; docs: RenderedDoc[] }
  | { kind: "error"; message: string };

export function TestPanel({
  prodSpecId,
  styles,
  enabledOutputCount,
  hasGeneralInfo,
  flush,
}: {
  prodSpecId: string;
  styles: TestStyle[];
  enabledOutputCount: number;
  hasGeneralInfo: boolean;
  // Flush any pending autosave so the test reflects the latest config.
  flush: () => Promise<void>;
}) {
  const [styleId, setStyleId] = useState<string | null>(styles[0]?.id ?? null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const blobUrlsRef = useRef<string[]>([]);

  // Revoke every Blob URL we created on unmount — they leak otherwise.
  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current = [];
    };
  }, []);

  function revokeAll() {
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current = [];
  }

  async function generate() {
    if (!styleId) return;
    // Persist any pending edits first so the PDFs reflect the current config.
    await flush();
    revokeAll();
    setPhase({ kind: "generating" });
    try {
      const res = await fetch(
        `/api/admin/prod-specs/${prodSpecId}/test-pdf?styleId=${encodeURIComponent(styleId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase({ kind: "error", message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as TestResult;
      const docs: RenderedDoc[] = data.docs.map((d) => ({
        ...d,
        blobUrl: d.pdfBase64 ? base64ToBlobUrl(d.pdfBase64) : null,
      }));
      blobUrlsRef.current = docs.map((d) => d.blobUrl).filter((u): u is string => u !== null);
      setPhase({ kind: "done", style: data.style, warnings: data.warnings, docs });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Request failed" });
    }
  }

  const generating = phase.kind === "generating";

  if (styles.length === 0) {
    return (
      <Section title="Test generation">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          No styles are linked to this prod spec yet. Styles link automatically on Monday
          ingest (matched by Customer × Business area) — once one lands, pick it here to
          generate test PDFs.
        </div>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title="Test generation">
        <p className="mb-3 text-xs text-zinc-500">
          A dry run of the generator. Pick a real style, and we render the{" "}
          <strong>cover page</strong>
          {hasGeneralInfo ? ", the general information document," : ""} plus{" "}
          <strong>
            {enabledOutputCount} output{enabledOutputCount === 1 ? "" : "s"}
          </strong>{" "}
          to actual PDFs — exactly what a rerun would produce — so you can see how everything
          looks. <strong>No job is created, nothing is saved, and no reviewer is notified.</strong>{" "}
          Uses the last-saved configuration (any pending edits flush first).
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[18rem] flex-1">
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              Style to test
            </label>
            <Combobox
              mode="single"
              options={styles.map((s) => ({
                value: s.id,
                label: s.name,
                hint: (
                  <span className="text-[11px] text-zinc-400">
                    {s.poNumber ? `PO ${s.poNumber} · ` : ""}
                    {s.completionPct}%
                  </span>
                ),
              }))}
              value={styleId}
              onChange={setStyleId}
              placeholder="Search styles…"
              emptyLabel="No matching styles"
            />
          </div>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating || !styleId}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? (
              <>
                <Spinner />
                Generating…
              </>
            ) : phase.kind === "done" ? (
              "Re-generate"
            ) : (
              "Generate test PDFs"
            )}
          </button>
        </div>
        {generating && (
          <p className="mt-2 text-[11px] text-zinc-400">
            Rendering each PDF through the real pipeline — this can take a few seconds.
          </p>
        )}
      </Section>

      {phase.kind === "error" && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <span className="font-medium">Test generation failed.</span> {phase.message}
        </div>
      )}

      {phase.kind === "done" && (
        <>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-600">
            Test bundle for{" "}
            <strong className="text-zinc-800">{phase.style.name}</strong> ·{" "}
            {phase.style.styleNumber}
            {phase.style.poNumber ? ` · PO ${phase.style.poNumber}` : ""} —{" "}
            {phase.docs.length} document{phase.docs.length === 1 ? "" : "s"}. These are
            throwaway previews; nothing was saved or sent.
          </div>

          {phase.warnings.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <ul className="list-disc space-y-1 pl-4">
                {phase.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {phase.docs.map((d, i) => (
              <DocCard key={`${d.variantKey}-${i}`} doc={d} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DocCard({ doc }: { doc: RenderedDoc }) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-zinc-100 px-4 py-2.5">
        {(doc.kind === "cover" || doc.kind === "general-info") && (
          <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
            {doc.kind === "cover" ? "Cover" : "Info"}
          </span>
        )}
        <span className="text-sm font-medium text-zinc-800">{doc.name}</span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] tabular-nums text-zinc-600">
          {fmtMm(doc.widthMm)} × {fmtMm(doc.heightMm)} mm
        </span>
        {doc.staticPdf && (
          <span
            className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700"
            title="Committed artwork — shipped verbatim, the app does not redraw it"
          >
            Static artwork
          </span>
        )}
        {doc.placeholderCount > 0 && (
          <span
            className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
            title="Missing-data placeholders in the artwork — these block approval on a real run"
          >
            {doc.placeholderCount} placeholder{doc.placeholderCount === 1 ? "" : "s"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {doc.blobUrl && (
            <>
              <a
                href={doc.blobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:underline"
              >
                Open
              </a>
              <a
                href={doc.blobUrl}
                download={doc.fileName ?? "document.pdf"}
                className="text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:underline"
              >
                Download
              </a>
            </>
          )}
        </div>
      </div>
      {doc.error ? (
        <div className="m-4 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-700">
          <span className="font-medium">Failed to render this document.</span> {doc.error}
        </div>
      ) : doc.blobUrl ? (
        <iframe
          src={doc.blobUrl}
          className="block h-[640px] w-full bg-zinc-100"
          title={doc.name}
        />
      ) : null}
    </section>
  );
}

// Decode base64 PDF bytes into a Blob URL the browser can embed/download.
function base64ToBlobUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}

function fmtMm(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h2>
      {children}
    </section>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-white"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
