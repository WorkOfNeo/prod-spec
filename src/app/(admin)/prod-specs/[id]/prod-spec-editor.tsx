"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BundlePageSettings, PageSettings, ProdSpecOutput } from "@/lib/prod-spec/config";
import {
  PINNABLE_FIELDS,
  PINNABLE_FIELD_LABELS,
  parseFieldOverrides,
  type PinnableField,
} from "@/lib/pdf/pins-meta";
import { Toggle } from "@/components/toggle";
import { Combobox } from "@/components/ui/combobox";
import { LazyOutputPreview } from "@/components/output-preview";
import { MarkdownEditor } from "@/components/markdown-editor";
import { PageSettingsFields } from "./page-settings-fields";
import {
  CareStandardPanel,
  type PanelCareLabel,
  type PanelSymbol,
} from "./care-standard-panel";
import { AddOutputPicker, type VariantInfo } from "./add-output-picker";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type Tab = "general" | "cover" | "outputs";

// Debounce window before the auto-saver flushes a payload. Long enough
// to coalesce rapid typing in the markdown / care-instruction textareas,
// short enough to feel automatic.
const AUTOSAVE_DEBOUNCE_MS = 1200;

type Props = {
  prodSpecId: string;
  initialTab: Tab;
  initialName: string;
  initialActive: boolean;
  initialThreshold: number;
  initialOutputs: ProdSpecOutput[];
  initialLogoSvg: string | null;
  // Markdown for the "General information" A4 page shipped with every
  // generated bundle. Empty string ⇒ no page emitted by the runner.
  initialGeneralInfoMd: string;
  // Print tuning (margins / base font / line height / footer) for the
  // two framing pages — parsed server-side with defaults filled in.
  initialBundlePageSettings: BundlePageSettings;
  initialCareInstructionsByLang: Record<string, string>;
  // Lowercase language codes this prod spec's outputs render. Empty ⇒
  // templates use their built-in default set.
  initialOutputLanguages: string[];
  // Active Language rows from the DB — drives the language picker and the
  // Care instructions editor columns. Adding a row to /languages adds an
  // option here automatically.
  availableLanguages: Array<{ code: string; name: string }>;
  // Suppliers / column mapping / required fields left this editor — they
  // are managed at Customer level (and via the supplier-link flow). The
  // DB values still apply at render time, so when a spec carries hidden
  // overrides we surface a read-only notice instead of silent state.
  hasColumnMappingOverride: boolean;
  hasRequiredFieldsOverride: boolean;
  attachedSupplierCount: number;
  variantCatalogue: VariantInfo[];
  // The standard care-label catalogue + symbol catalogue + per-label
  // Translation-board entries — drives the "generated from standard" panel.
  careLabels: PanelCareLabel[];
  washSymbols: PanelSymbol[];
  careTranslationsByLabel: Record<string, Record<string, string>>;
};

export function ProdSpecEditor(props: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(props.initialTab);
  const [name, setName] = useState(props.initialName);
  const [active, setActive] = useState(props.initialActive);
  const [threshold, setThreshold] = useState(props.initialThreshold);
  const [outputs, setOutputs] = useState<ProdSpecOutput[]>(props.initialOutputs);
  const [logoSvg, setLogoSvg] = useState<string>(props.initialLogoSvg ?? "");
  const [generalInfoMd, setGeneralInfoMd] = useState<string>(props.initialGeneralInfoMd);
  const [pageSettings, setPageSettings] = useState<BundlePageSettings>(
    props.initialBundlePageSettings,
  );
  const [careByLang, setCareByLang] = useState<Record<string, string>>(
    props.initialCareInstructionsByLang ?? {},
  );
  // Selected output languages. Stored as a Set; the saved order follows the
  // /languages sortOrder (props.availableLanguages order) so output is stable.
  const [outputLangs, setOutputLangs] = useState<Set<string>>(
    () => new Set(props.initialOutputLanguages ?? []),
  );
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const variantByKey = new Map(props.variantCatalogue.map((v) => [v.key, v]));
  const addedKeys = new Set(outputs.map((o) => o.variantKey));
  const unaddedVariants = props.variantCatalogue.filter((v) => !addedKeys.has(v.key));
  const enabledCount = outputs.filter((o) => o.enabled !== false).length;

  function switchTab(next: Tab) {
    setTab(next);
    // Shallow URL sync — a router navigation would re-mount the editor and
    // drop in-flight (debounced, unsaved) state.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  function updateOutput(index: number, patch: Partial<ProdSpecOutput>) {
    setOutputs((prev) =>
      prev.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    );
  }

  function removeOutput(index: number) {
    setOutputs((prev) => prev.filter((_, i) => i !== index));
  }

  function addOutput(variant: VariantInfo) {
    setOutputs((prev) => [
      ...prev,
      {
        variantKey: variant.key,
        widthMm: variant.defaultWidthMm,
        heightMm: variant.defaultHeightMm,
        enabled: true,
      },
    ]);
  }

  // Accept SVG (stored as raw markup) or PNG/JPG (stored as a base64
  // data URL). care-label-01's renderer handles both shapes — inline SVG
  // goes straight into the DOM, data URLs render via <img>.
  async function readLogoFile(file: File) {
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const isRaster =
      file.type === "image/png" ||
      file.type === "image/jpeg" ||
      /\.(png|jpe?g)$/i.test(file.name);

    if (isSvg) {
      if (file.size > 256_000) {
        setLogoErr("SVG too large (max 256 KB)");
        return;
      }
      const text = await file.text();
      setLogoSvg(text);
      setLogoErr(null);
      return;
    }

    if (isRaster) {
      if (file.size > 2_000_000) {
        setLogoErr("Image too large (max 2 MB) — prefer SVG or a smaller PNG");
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        setLogoSvg(dataUrl);
        setLogoErr(null);
      } catch {
        setLogoErr(`Could not read "${file.name}"`);
      }
      return;
    }

    setLogoErr(`Expected an SVG, PNG, or JPG file, got "${file.name}" (${file.type || "no type"})`);
  }

  function onLogoDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
    setDragOver(true);
  }
  function onLogoDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragDepth((d) => {
      const next = d - 1;
      if (next <= 0) setDragOver(false);
      return Math.max(next, 0);
    });
  }
  function onLogoDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onLogoDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    setDragDepth(0);
    const file = e.dataTransfer.files?.[0];
    if (file) void readLogoFile(file);
  }

  // Selected output languages, ordered by /languages sortOrder (the order of
  // props.availableLanguages). Any selected code no longer in the active set
  // (e.g. a language got deactivated) is appended at the end rather than
  // silently dropped on an unrelated save.
  const outputLanguageList = useMemo(() => {
    const active = props.availableLanguages.map((l) => l.code);
    const inOrder = active.filter((c) => outputLangs.has(c));
    const extras = Array.from(outputLangs).filter((c) => !active.includes(c));
    return [...inOrder, ...extras];
  }, [outputLangs, props.availableLanguages]);

  // The current form payload, derived. Used for dirty-detection: when its
  // serialisation differs from `lastSavedPayloadRef`, auto-save kicks in.
  // Suppliers / column mapping / required fields are deliberately absent —
  // this editor no longer touches them, so existing DB values persist.
  const payload = useMemo(
    () => ({
      name,
      active,
      autoGenerateThresholdPct: threshold,
      outputs,
      logoSvg: logoSvg.trim() ? logoSvg : null,
      generalInfoMd: generalInfoMd.trim() ? generalInfoMd : null,
      bundlePageSettings: pageSettings,
      careInstructionsByLang: careByLang,
      outputLanguages: outputLanguageList,
    }),
    [
      name,
      active,
      threshold,
      outputs,
      logoSvg,
      generalInfoMd,
      pageSettings,
      careByLang,
      outputLanguageList,
    ],
  );

  // Snapshot of the last *successfully saved* payload, serialised. The
  // auto-save effect compares JSON.stringify(payload) against this ref
  // to decide whether a flush is needed.
  const lastSavedPayloadRef = useRef<string>(JSON.stringify(payload));
  const saveTimeoutRef = useRef<number | null>(null);
  // Bumped on each `save` call so a late response from a stale request
  // can't overwrite the status set by a newer request.
  const saveSeqRef = useRef(0);

  async function save(): Promise<void> {
    const mySeq = ++saveSeqRef.current;
    setError(null);
    setStatus("saving");
    try {
      const body = JSON.stringify(payload);
      const res = await fetch(`/api/admin/prod-specs/${props.prodSpecId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (mySeq !== saveSeqRef.current) return; // stale response
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(
          errBody.error
            ? `${errBody.error}${errBody.details ? ` — ${JSON.stringify(errBody.details)}` : ""}`
            : `HTTP ${res.status}`,
        );
        setStatus("error");
        return;
      }
      lastSavedPayloadRef.current = body;
      setSavedAt(new Date().toLocaleTimeString());
      setStatus("saved");
      router.refresh();
    } catch (err) {
      if (mySeq !== saveSeqRef.current) return;
      setError((err as Error).message);
      setStatus("error");
    }
  }

  // Debounced auto-save. Watches the *serialised* payload; if it differs
  // from the last-saved snapshot, marks the form dirty and schedules a
  // save AUTOSAVE_DEBOUNCE_MS after the most recent change. setState
  // calls in this effect are intentional — they reflect transient UI
  // status ("dirty"), and a debounced async save needs schedule + cancel
  // semantics that only an effect can give us.
  useEffect(() => {
    const serialised = JSON.stringify(payload);
    if (serialised === lastSavedPayloadRef.current) return;
    setStatus("dirty");
    setError(null);
    if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = window.setTimeout(() => {
      void save();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // Flush on tab close — best-effort, doesn't block navigation.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (status === "dirty" || status === "saving") {
        e.preventDefault();
        // Chrome ignores the message string but honours preventDefault.
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status]);

  const careOverrideCount = Object.values(careByLang).filter((v) => v.trim().length > 0).length;
  const hasHiddenOverrides =
    props.hasColumnMappingOverride ||
    props.hasRequiredFieldsOverride ||
    props.attachedSupplierCount > 0;

  return (
    <div className="mt-6 flex flex-col gap-4">
      {/* Basics melted into one sticky row: identity + workflow knobs on
          the left, save state on the right. */}
      <HeaderBar
        status={status}
        savedAt={savedAt}
        error={error}
        onSaveNow={() => void save()}
        name={name}
        onName={setName}
        threshold={threshold}
        onThreshold={setThreshold}
        active={active}
        onActive={setActive}
      />

      <nav className="border-b border-zinc-200">
        <ul className="-mb-px flex gap-1">
          {(
            [
              { key: "general" as const, label: "General information" },
              { key: "cover" as const, label: "Cover page" },
              { key: "outputs" as const, label: "Outputs", count: enabledCount },
            ] satisfies Array<{ key: Tab; label: string; count?: number }>
          ).map((t) => (
            <li key={t.key}>
              <button
                type="button"
                onClick={() => switchTab(t.key)}
                className={`inline-block border-b-2 px-3.5 py-2 text-sm font-medium transition-colors ${
                  tab === t.key
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {t.label}
                {t.count !== undefined && (
                  <span className="ml-1.5 text-[11px] text-zinc-400">{t.count}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "general" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Section title="General information page">
              <p className="mb-3 text-xs text-zinc-500">
                Write it once — general requirements, inspection standards, packing rules. When
                non-empty, this page joins <strong>every bundle</strong> generated under this prod
                spec as <code className="font-mono">01-…-general-information.pdf</code>. Type{" "}
                <code className="font-mono">#</code> + space for a heading,{" "}
                <code className="font-mono">-</code> + space for a list; tables insert from the
                toolbar. Markdown under the hood — flip to the Markdown view to paste raw source.
              </p>
              <MarkdownEditor value={generalInfoMd} onChange={setGeneralInfoMd} />
              <p className="mt-1 text-[11px] text-zinc-400">
                Long content flows onto further A4 pages automatically. Preview refreshes after
                each autosave.
              </p>
            </Section>

            <Section title="Page settings · general information">
              <PageSettingsFields
                value={pageSettings.generalInfo}
                onChange={(generalInfo: PageSettings) =>
                  setPageSettings((prev) => ({ ...prev, generalInfo }))
                }
              />
            </Section>
          </div>

          <Section title="A4 preview">
            <div className="rounded-md bg-zinc-100 p-3">
              <LazyOutputPreview
                src={`/api/admin/prod-specs/${props.prodSpecId}/general-info-preview`}
                widthMm={210}
                heightMm={297}
                refreshKey={savedAt ?? undefined}
              />
            </div>
          </Section>
        </div>
      ) : tab === "cover" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Section title="Cover page · auto-generated">
              <p className="mb-3 text-xs text-zinc-500">
                First page of every bundle: each enabled output&apos;s title and dimensions, once.
                The General information pages are appended into this same document (with their
                own page settings), so the requirements always travel with the cover. The content
                is read-only — it follows the Outputs and General information tabs; the runner
                builds the real one from the documents a job actually generated. Tune how the
                cover sheet prints below.
              </p>
            </Section>

            <Section title="Page settings · cover page">
              <PageSettingsFields
                value={pageSettings.cover}
                onChange={(cover: PageSettings) => setPageSettings((prev) => ({ ...prev, cover }))}
              />
            </Section>
          </div>

          <Section title="A4 preview">
            <div className="rounded-md bg-zinc-100 p-3">
              <LazyOutputPreview
                src={`/api/admin/prod-specs/${props.prodSpecId}/cover-preview`}
                widthMm={210}
                heightMm={297}
                refreshKey={savedAt ?? undefined}
              />
            </div>
          </Section>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Section title="Outputs">
            <p className="mb-3 text-xs text-zinc-500">
              Each enabled entry generates one PDF when the style runs through the runner. Width
              and height are in mm and override the variant&apos;s defaults. Pins and a live
              preview sit behind each row&apos;s expander.
            </p>

            {outputs.length === 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                No outputs selected — saving will leave this ProdSpec rendering nothing. Add at
                least one variant below.
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {outputs.map((o, i) => {
                  const v = variantByKey.get(o.variantKey);
                  const pinCount = Object.keys(parseFieldOverrides(o.fieldOverrides)).length;
                  return (
                    <li
                      key={`${o.variantKey}-${i}`}
                      className={`rounded-md border bg-white px-3 py-2 ${
                        o.enabled ? "border-zinc-200" : "border-amber-300 bg-amber-50/60"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Toggle
                          checked={o.enabled}
                          onChange={(next) => updateOutput(i, { enabled: next })}
                          ariaLabel={`${v?.name ?? o.variantKey} enabled`}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" title={v?.description}>
                            {v?.name ?? o.variantKey}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-zinc-400">
                            {o.variantKey}
                            {v ? <> · {v.docType}</> : <> · <span className="text-red-700">unknown variant</span></>}
                          </span>
                        </div>
                        <label className="flex shrink-0 items-center gap-1 text-[10px] uppercase text-zinc-500">
                          <input
                            type="number"
                            step={0.1}
                            min={1}
                            value={o.widthMm}
                            onChange={(e) => updateOutput(i, { widthMm: Number(e.target.value) })}
                            className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-sm tabular-nums"
                            aria-label="Width mm"
                          />
                          ×
                          <input
                            type="number"
                            step={0.1}
                            min={1}
                            value={o.heightMm}
                            onChange={(e) => updateOutput(i, { heightMm: Number(e.target.value) })}
                            className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-sm tabular-nums"
                            aria-label="Height mm"
                          />
                          mm
                        </label>
                        <button
                          type="button"
                          onClick={() => removeOutput(i)}
                          className="shrink-0 text-sm text-zinc-400 hover:text-red-700"
                          aria-label={`Remove ${v?.name ?? o.variantKey}`}
                          title="Remove output"
                        >
                          ✕
                        </button>
                      </div>

                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-800">
                          📌 {pinCount === 0 ? "no pins" : `${pinCount} pin${pinCount === 1 ? "" : "s"}`} ·
                          preview
                        </summary>
                        <div className="mt-2 border-t border-zinc-100 pt-2">
                          {/* Carton barcode preference — CARTON_MARKING outputs
                              only. EAN-128 = Code 128 bars + number beneath (the
                              default); EAN-13 = digits inside the symbol. Height
                              overrides the renderer default (16 mm coded template
                              / font-scaled in builder layouts). */}
                          {v?.docType === "CARTON_MARKING" && (
                            <div className="mb-3 flex flex-wrap items-center gap-3">
                              <label className="text-[10px] uppercase text-zinc-500">
                                Carton barcode
                                <select
                                  value={o.cartonBarcodeType ?? "ean128"}
                                  onChange={(e) =>
                                    updateOutput(i, {
                                      cartonBarcodeType: e.target.value === "ean13" ? "ean13" : undefined,
                                    })
                                  }
                                  className="ml-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm normal-case text-zinc-800"
                                >
                                  <option value="ean128">EAN-128 (Code 128) — default</option>
                                  <option value="ean13">EAN-13</option>
                                </select>
                              </label>
                              <label className="text-[10px] uppercase text-zinc-500">
                                Bar height mm
                                <input
                                  type="number"
                                  step={0.5}
                                  min={4}
                                  max={60}
                                  placeholder="auto"
                                  value={o.cartonBarcodeHeightMm ?? ""}
                                  onChange={(e) =>
                                    updateOutput(i, {
                                      cartonBarcodeHeightMm: e.target.value ? Number(e.target.value) : undefined,
                                    })
                                  }
                                  className="ml-1 w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm tabular-nums"
                                />
                              </label>
                            </div>
                          )}
                          <PinControls
                            overrides={o.fieldOverrides}
                            onChange={(fieldOverrides) => updateOutput(i, { fieldOverrides })}
                          />
                          {/* Sample preview wearing THIS spec's config (logo,
                              languages, care override, pins, dims). Refetches
                              after each autosave. */}
                          <div className="mt-3 rounded-md bg-zinc-100 p-3">
                            <LazyOutputPreview
                              src={`/api/admin/prod-specs/${props.prodSpecId}/output-preview?variantKey=${encodeURIComponent(o.variantKey)}`}
                              widthMm={o.widthMm}
                              heightMm={o.heightMm}
                              refreshKey={savedAt ?? undefined}
                            />
                          </div>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}

            {unaddedVariants.length > 0 && (
              <AddOutputPicker
                variants={unaddedVariants}
                prodSpecId={props.prodSpecId}
                onAdd={addOutput}
                previewRefreshKey={savedAt ?? undefined}
              />
            )}
          </Section>

          {/* Everything below feeds rendering, so it stays reachable — it
              just stops occupying three screens. Collapsed by default with
              a state summary in the header. */}
          <details className="group rounded-lg border border-zinc-200 bg-zinc-50">
            <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-100/60">
              <span>Advanced print configuration</span>
              <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-normal">
                <SummaryChip>{logoSvg.trim() ? "Logo: set ✓" : "Logo: none"}</SummaryChip>
                <SummaryChip>
                  {outputLanguageList.length === 0
                    ? "Languages: template default"
                    : `Languages: ${outputLanguageList.join(", ")}`}
                </SummaryChip>
                <SummaryChip>
                  {careOverrideCount === 0
                    ? "Care overrides: none"
                    : `Care overrides: ${careOverrideCount}`}
                </SummaryChip>
              </span>
            </summary>

            <div className="flex flex-col gap-4 border-t border-zinc-200 bg-white p-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Logo (Customer × Business Area)
                </h3>
                <p className="mt-1 mb-2 text-xs text-zinc-500">
                  Used by templates that render a branded header — currently{" "}
                  <code className="font-mono">care-label-01</code> (~16×7 mm at the top of each
                  label). Upload an <strong>SVG, PNG, or JPG</strong> (drop a file anywhere in this
                  block), or paste SVG markup. SVG preferred; PNG at ~400×175 px works; max
                  256&nbsp;KB SVG / 2&nbsp;MB raster.
                </p>
                <div
                  onDragEnter={onLogoDragEnter}
                  onDragLeave={onLogoDragLeave}
                  onDragOver={onLogoDragOver}
                  onDrop={onLogoDrop}
                  className={`relative grid grid-cols-1 gap-4 rounded-md p-2 transition sm:grid-cols-2 ${
                    dragOver ? "ring-4 ring-zinc-900 ring-offset-2" : ""
                  }`}
                >
                  {dragOver && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-zinc-900/5">
                      <div className="rounded-md border-2 border-dashed border-zinc-900 bg-white/95 px-6 py-3 text-sm font-medium text-zinc-900">
                        Drop SVG, PNG, or JPG to attach
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="text-xs font-medium text-zinc-700">
                      Logo file (SVG, PNG, JPG)
                      <input
                        type="file"
                        accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void readLogoFile(f);
                        }}
                        className="mt-1 block w-full text-xs"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-medium text-zinc-700">
                      Or paste SVG markup
                      <textarea
                        value={logoSvg}
                        onChange={(e) => setLogoSvg(e.target.value)}
                        rows={5}
                        spellCheck={false}
                        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-[10px]"
                        placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30">…</svg>'}
                      />
                    </label>
                    {logoSvg && (
                      <button
                        type="button"
                        onClick={() => setLogoSvg("")}
                        className="mt-2 text-xs text-red-700 underline"
                      >
                        Clear logo
                      </button>
                    )}
                    {logoErr && <p className="mt-2 text-xs text-red-600">{logoErr}</p>}
                  </div>
                  <div>
                    <div className="text-xs font-medium text-zinc-700">Preview</div>
                    <div className="mt-1 flex h-24 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
                      {logoSvg ? (
                        logoSvg.trim().startsWith("data:") ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={logoSvg.trim()}
                            alt="logo preview"
                            className="max-h-20 max-w-[12rem] object-contain"
                          />
                        ) : (
                          <div
                            className="max-h-20 max-w-[12rem] [&_svg]:h-full [&_svg]:w-full"
                            dangerouslySetInnerHTML={{ __html: logoSvg }}
                          />
                        )
                      ) : (
                        <span className="text-xs text-zinc-500">no logo set</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-zinc-100 pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Output languages
                </h3>
                <p className="mt-1 mb-2 text-xs text-zinc-500">
                  Languages this prod spec&apos;s outputs render (care labels, info area, …), pulled
                  from the synced Translation board. Leave empty to fall back to each
                  template&apos;s built-in default set. Manage the list at{" "}
                  <code className="font-mono">/languages</code>, or toggle across all prod specs on
                  the <code className="font-mono">/prod-specs/languages</code> matrix.
                </p>
                {props.availableLanguages.length === 0 ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    No active languages — visit <code className="font-mono">/languages</code> and
                    click <strong>Seed standard set</strong>.
                  </p>
                ) : (
                  <div className="max-w-md">
                    <Combobox
                      mode="multi"
                      options={props.availableLanguages.map((l) => ({
                        value: l.code,
                        label: `${l.name} (${l.code})`,
                      }))}
                      value={outputLanguageList}
                      onChange={(codes) => setOutputLangs(new Set(codes))}
                      placeholder="Search languages…"
                      emptyLabel="No matching languages"
                    />
                  </div>
                )}
              </div>

              <div className="border-t border-zinc-100 pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Care instructions — generated from the standard
                </h3>
                <p className="mt-1 mb-2 text-xs text-zinc-500">
                  The printed care text composes from the central catalogue at{" "}
                  <code className="font-mono">/settings/care-labels</code>: every active line,
                  filtered per product by the style&apos;s wash-care symbols, translated per
                  language from the Translation board. Nothing is typed per prod spec — tune the
                  catalogue, and every output follows. A per-language <em>override</em> replaces
                  the standard verbatim; it&apos;s available below each line, loudly badged.
                </p>
                {props.availableLanguages.length === 0 ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    No active languages — visit <code className="font-mono">/languages</code> and
                    click <strong>Seed standard set</strong> to populate the editor.
                  </p>
                ) : (
                  <CareStandardPanel
                    careLabels={props.careLabels}
                    symbols={props.washSymbols}
                    translationsByLabel={props.careTranslationsByLabel}
                    languages={props.availableLanguages}
                    selectedLanguages={outputLanguageList}
                    careByLang={careByLang}
                    onChangeCareByLang={(code, value) =>
                      setCareByLang((prev) => ({ ...prev, [code]: value }))
                    }
                  />
                )}
              </div>
            </div>
          </details>

          {hasHiddenOverrides && (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-xs text-zinc-500">
              <span className="font-medium text-zinc-600">
                Managed outside this editor now:
              </span>{" "}
              suppliers, column mapping and required fields.{" "}
              <span className="inline-flex flex-wrap gap-1.5 align-middle">
                {props.attachedSupplierCount > 0 && (
                  <SummaryChip>{props.attachedSupplierCount} supplier(s) attached</SummaryChip>
                )}
                {props.hasColumnMappingOverride && (
                  <SummaryChip tone="warn">⚠ carries column-mapping override</SummaryChip>
                )}
                {props.hasRequiredFieldsOverride && (
                  <SummaryChip tone="warn">⚠ carries required-fields override</SummaryChip>
                )}
              </span>{" "}
              Stored values still apply at render time.
            </div>
          )}
        </div>
      )}

      {/* Auto-save handles persistence — there's no submit button. The
          sticky header bar reflects the latest state and exposes a manual
          "Save now" if the operator wants to flush before the debounce
          fires. */}
    </div>
  );
}

// Per-output pin editor: existing pins as chips with one-click unpin, plus
// a field+value picker to add one. "📌 Customer name (printed) = Netto A/S"
// — the constant wins over everything at render time and satisfies
// readiness for that field.
function PinControls({
  overrides,
  onChange,
}: {
  overrides: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const pins = parseFieldOverrides(overrides);
  const pinnedKeys = Object.keys(pins) as PinnableField[];
  const available = PINNABLE_FIELDS.filter((f) => !pinnedKeys.includes(f));
  const [field, setField] = useState<PinnableField | "">("");
  const [value, setValue] = useState("");

  function add() {
    if (!field || !value.trim()) return;
    onChange({ ...pins, [field]: value.trim() });
    setField("");
    setValue("");
  }
  function remove(key: PinnableField) {
    const next: Record<string, string> = { ...pins };
    delete next[key];
    onChange(Object.keys(next).length > 0 ? next : undefined);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">Pins</span>
        {pinnedKeys.length === 0 && (
          <span className="text-[11px] text-zinc-400">none — every field follows the row</span>
        )}
        {pinnedKeys.map((key) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700"
            title="Pinned — always this value on this output, regardless of the Monday row"
          >
            📌 {PINNABLE_FIELD_LABELS[key]} = {pins[key]}
            <button
              type="button"
              onClick={() => remove(key)}
              className="ml-0.5 text-zinc-400 hover:text-red-700"
              aria-label={`Unpin ${PINNABLE_FIELD_LABELS[key]}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={field}
          onChange={(e) => setField(e.target.value as PinnableField | "")}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
        >
          <option value="">Pin a field…</option>
          {available.map((f) => (
            <option key={f} value={f}>
              {PINNABLE_FIELD_LABELS[f]}
            </option>
          ))}
        </select>
        {field && (
          <>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="Always this value…"
              className="w-56 rounded-md border border-zinc-300 px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={add}
              disabled={!value.trim()}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              Pin
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// Basics + save state in one sticky row. Name, threshold and Active used
// to be a full-height "Basics" card — three values don't need a screen.
function HeaderBar({
  status,
  savedAt,
  error,
  onSaveNow,
  name,
  onName,
  threshold,
  onThreshold,
  active,
  onActive,
}: {
  status: SaveStatus;
  savedAt: string | null;
  error: string | null;
  onSaveNow: () => void;
  name: string;
  onName: (v: string) => void;
  threshold: number;
  onThreshold: (v: number) => void;
  active: boolean;
  onActive: (v: boolean) => void;
}) {
  const label = (() => {
    switch (status) {
      case "saving":
        return "Saving…";
      case "saved":
        return savedAt ? `Saved · ${savedAt}` : "Saved";
      case "dirty":
        return "Unsaved changes — auto-saving…";
      case "error":
        return error ? `Error: ${error}` : "Error";
      case "idle":
      default:
        return savedAt ? `Saved · ${savedAt}` : "Auto-save on";
    }
  })();

  const tone = (() => {
    switch (status) {
      case "saving":
        return "border-zinc-200 bg-zinc-50";
      case "saved":
      case "idle":
        return "border-emerald-200 bg-emerald-50/70";
      case "dirty":
        return "border-amber-200 bg-amber-50/70";
      case "error":
        return "border-red-200 bg-red-50/70";
    }
  })();

  return (
    <div
      className={`sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 ${tone}`}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => onName(e.target.value)}
        required
        aria-label="Prod spec name"
        className="min-w-48 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium"
      />
      <label
        className="flex shrink-0 items-center gap-1 text-[10px] uppercase text-zinc-500"
        title="Completion % at which a Style auto-enqueues a generation job"
      >
        Auto-gen
        <input
          type="number"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => onThreshold(Math.max(0, Math.min(100, Number(e.target.value))))}
          className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums"
        />
        %
      </label>
      <Toggle checked={active} onChange={onActive} label={active ? "Active" : "Disabled"} size="sm" />
      <div className="ml-auto flex shrink-0 items-center gap-2 text-xs">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
            status === "saving"
              ? "animate-pulse bg-zinc-400"
              : status === "dirty"
                ? "bg-amber-500"
                : status === "error"
                  ? "bg-red-500"
                  : "bg-emerald-500"
          }`}
        />
        <span className="max-w-72 truncate text-zinc-700" title={label}>
          {label}
        </span>
        <button
          type="button"
          onClick={onSaveNow}
          disabled={status === "saving"}
          className="flex-shrink-0 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Save now
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h2>
      {children}
    </section>
  );
}

function SummaryChip({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "warn";
}) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-zinc-200 bg-white text-zinc-600"
      }`}
    >
      {children}
    </span>
  );
}
