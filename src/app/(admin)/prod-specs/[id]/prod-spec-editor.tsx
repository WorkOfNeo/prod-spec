"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProdSpecOutput } from "@/lib/prod-spec/config";
import type { ColumnMapping, RequiredField } from "@/lib/customers/config";
import {
  PINNABLE_FIELDS,
  PINNABLE_FIELD_LABELS,
  parseFieldOverrides,
  type PinnableField,
} from "@/lib/pdf/pins-meta";
import { Toggle } from "@/components/toggle";
import { Combobox } from "@/components/ui/combobox";
import { LazyOutputPreview } from "@/components/output-preview";
import {
  CareStandardPanel,
  type PanelCareLabel,
  type PanelSymbol,
} from "./care-standard-panel";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

// Debounce window before the auto-saver flushes a payload. Long enough
// to coalesce rapid typing in JSON / care-instruction textareas, short
// enough to feel automatic.
const AUTOSAVE_DEBOUNCE_MS = 1200;

type VariantInfo = {
  key: string;
  docType: string;
  name: string;
  description: string;
  defaultWidthMm: number;
  defaultHeightMm: number;
};

type SupplierSummary = { id: string; name: string; country: string | null };

type Props = {
  prodSpecId: string;
  initialName: string;
  initialActive: boolean;
  initialThreshold: number;
  initialOutputs: ProdSpecOutput[];
  initialLogoSvg: string | null;
  initialCareInstructionsByLang: Record<string, string>;
  // Lowercase language codes this prod spec's outputs render. Empty ⇒
  // templates use their built-in default set.
  initialOutputLanguages: string[];
  // Active Language rows from the DB — drives the column set in the
  // Care instructions editor and the Output languages toggles. Adding a
  // row to /languages adds an input here automatically.
  availableLanguages: Array<{ code: string; name: string }>;
  initialColumnMapping: ColumnMapping;
  initialRequiredFields: RequiredField[];
  attachedSupplierIds: string[];
  allSuppliers: SupplierSummary[];
  variantCatalogue: VariantInfo[];
  // The standard care-label catalogue + symbol catalogue + per-label
  // Translation-board entries — drives the "generated from standard" panel.
  careLabels: PanelCareLabel[];
  washSymbols: PanelSymbol[];
  careTranslationsByLabel: Record<string, Record<string, string>>;
};

export function ProdSpecEditor(props: Props) {
  const router = useRouter();
  const [name, setName] = useState(props.initialName);
  const [active, setActive] = useState(props.initialActive);
  const [threshold, setThreshold] = useState(props.initialThreshold);
  const [outputs, setOutputs] = useState<ProdSpecOutput[]>(props.initialOutputs);
  const [logoSvg, setLogoSvg] = useState<string>(props.initialLogoSvg ?? "");
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
  const [supplierIds, setSupplierIds] = useState<Set<string>>(new Set(props.attachedSupplierIds));
  const [columnMappingText, setColumnMappingText] = useState(
    JSON.stringify(props.initialColumnMapping, null, 2),
  );
  const [requiredFieldsText, setRequiredFieldsText] = useState(
    JSON.stringify(props.initialRequiredFields, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const variantByKey = new Map(props.variantCatalogue.map((v) => [v.key, v]));
  const addedKeys = new Set(outputs.map((o) => o.variantKey));
  const unaddedVariants = props.variantCatalogue.filter((v) => !addedKeys.has(v.key));

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

  function toggleLang(code: string, next: boolean) {
    setOutputLangs((prev) => {
      const s = new Set(prev);
      if (next) s.add(code);
      else s.delete(code);
      return s;
    });
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

  // Serialised supplier list — Combobox wants a string[], not a Set.
  const supplierIdList = useMemo(() => Array.from(supplierIds), [supplierIds]);

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
  // JSON textareas can be invalid — in that case we *don't* short-circuit
  // dirty detection, but `save()` itself catches and surfaces the error.
  const payload = useMemo(() => {
    let columnMapping: unknown;
    let columnMappingError: string | null = null;
    try {
      columnMapping = JSON.parse(columnMappingText);
    } catch (err) {
      columnMappingError = `columnMapping JSON: ${(err as Error).message}`;
    }
    let requiredFields: unknown;
    let requiredFieldsError: string | null = null;
    try {
      requiredFields = JSON.parse(requiredFieldsText);
    } catch (err) {
      requiredFieldsError = `requiredFields JSON: ${(err as Error).message}`;
    }
    return {
      data: {
        name,
        active,
        autoGenerateThresholdPct: threshold,
        outputs,
        logoSvg: logoSvg.trim() ? logoSvg : null,
        careInstructionsByLang: careByLang,
        outputLanguages: outputLanguageList,
        columnMapping,
        requiredFields,
        supplierIds: supplierIdList,
      },
      columnMappingError,
      requiredFieldsError,
    };
  }, [
    name,
    active,
    threshold,
    outputs,
    logoSvg,
    careByLang,
    outputLanguageList,
    columnMappingText,
    requiredFieldsText,
    supplierIdList,
  ]);

  // Snapshot of the last *successfully saved* payload, serialised. The
  // auto-save effect compares JSON.stringify(payload.data) against this
  // ref to decide whether a flush is needed.
  const lastSavedPayloadRef = useRef<string>(JSON.stringify(payload.data));
  const saveTimeoutRef = useRef<number | null>(null);
  // Bumped on each `save` call so a late response from a stale request
  // can't overwrite the status set by a newer request.
  const saveSeqRef = useRef(0);

  async function save(): Promise<void> {
    if (payload.columnMappingError) {
      setError(payload.columnMappingError);
      setStatus("error");
      return;
    }
    if (payload.requiredFieldsError) {
      setError(payload.requiredFieldsError);
      setStatus("error");
      return;
    }
    const mySeq = ++saveSeqRef.current;
    setError(null);
    setStatus("saving");
    try {
      const body = JSON.stringify(payload.data);
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
  // save AUTOSAVE_DEBOUNCE_MS after the most recent change.
  //
  // Skips saving while a JSON textarea is in an invalid state — the
  // status pill shows "error" instead, so the user knows why nothing's
  // landing. Once they fix it, the next render re-runs this effect and
  // the save fires.
  // Debounced auto-save. setState calls in this effect are intentional —
  // they reflect transient UI status ("dirty"/"error") derived from
  // user-typed JSON validity, not from props. The react-hooks lint
  // would prefer pure derivation, but a debounced async save needs
  // schedule + cancel semantics that only an effect can give us.
  useEffect(() => {
    const serialised = JSON.stringify(payload.data);
    if (serialised === lastSavedPayloadRef.current) return;
    if (payload.columnMappingError || payload.requiredFieldsError) {
      setStatus("error");
      setError(payload.columnMappingError ?? payload.requiredFieldsError);
      return;
    }
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

  return (
    <div className="mt-6 flex flex-col gap-8">
      <SaveStatusBar status={status} savedAt={savedAt} error={error} onSaveNow={() => void save()} />
      <Section title="Basics">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            required
          />
        </Field>
        <Field label="Auto-generate threshold (%)" hint="Completion % at which a Style auto-enqueues a generation job.">
          <input
            type="number"
            min={0}
            max={100}
            value={threshold}
            onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value))))}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm tabular-nums"
          />
        </Field>
        <Field label="Active?">
          <div className="mt-2">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} size="md" />
          </div>
        </Field>
      </Section>

      <Section title="Outputs" wide>
        <p className="mb-3 text-xs text-zinc-500">
          Pick from the template catalogue. Each entry generates one PDF when the style runs through
          the runner. Width and height are in mm and override the variant's defaults.
        </p>

        {outputs.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            No outputs selected — saving will leave this ProdSpec rendering nothing. Add at least
            one variant below.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {outputs.map((o, i) => {
              const v = variantByKey.get(o.variantKey);
              return (
                <li
                  key={`${o.variantKey}-${i}`}
                  className={`rounded-lg border bg-white p-3 ${
                    o.enabled ? "border-zinc-200" : "border-amber-300 bg-amber-50/60"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5">
                      <Toggle
                        checked={o.enabled}
                        onChange={(next) => updateOutput(i, { enabled: next })}
                        ariaLabel={`${v?.name ?? o.variantKey} enabled`}
                        size="sm"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{v?.name ?? o.variantKey}</div>
                      <div className="font-mono text-[10px] text-zinc-500">
                        {o.variantKey}
                        {v ? <> · {v.docType}</> : <> · <span className="text-red-700">unknown variant</span></>}
                      </div>
                      {v?.description && (
                        <div className="mt-1 text-xs text-zinc-500">{v.description}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <label className="text-[10px] uppercase text-zinc-500">
                        W mm
                        <input
                          type="number"
                          step={0.1}
                          min={1}
                          value={o.widthMm}
                          onChange={(e) => updateOutput(i, { widthMm: Number(e.target.value) })}
                          className="ml-1 w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm tabular-nums"
                        />
                      </label>
                      <label className="text-[10px] uppercase text-zinc-500">
                        H mm
                        <input
                          type="number"
                          step={0.1}
                          min={1}
                          value={o.heightMm}
                          onChange={(e) => updateOutput(i, { heightMm: Number(e.target.value) })}
                          className="ml-1 w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm tabular-nums"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => removeOutput(i)}
                        className="text-xs text-red-700 underline"
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  {/* Per-output field pins — "this field is ALWAYS this string". */}
                  <div className="mt-3 border-t border-zinc-100 pt-3">
                    <PinControls
                      overrides={o.fieldOverrides}
                      onChange={(fieldOverrides) => updateOutput(i, { fieldOverrides })}
                    />
                  </div>

                  {/* Sample preview wearing THIS spec's config (logo, languages,
                      care override, pins, dims). Refetches after each autosave. */}
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-800">
                      Preview · sample data + this spec&apos;s configuration
                    </summary>
                    <div className="mt-2 rounded-md bg-zinc-100 p-3">
                      <LazyOutputPreview
                        src={`/api/admin/prod-specs/${props.prodSpecId}/output-preview?variantKey=${encodeURIComponent(o.variantKey)}`}
                        widthMm={o.widthMm}
                        heightMm={o.heightMm}
                        refreshKey={savedAt ?? undefined}
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        {unaddedVariants.length > 0 && (
          <details className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <summary className="cursor-pointer text-sm font-medium text-zinc-700">
              + Add output ({unaddedVariants.length} available)
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {unaddedVariants.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => addOutput(v)}
                  className="rounded-md border border-zinc-200 bg-white p-3 text-left hover:border-zinc-400"
                >
                  <div className="text-sm font-medium">{v.name}</div>
                  <div className="font-mono text-[10px] text-zinc-500">{v.key} · {v.docType}</div>
                  <div className="mt-1 text-xs text-zinc-500">{v.description}</div>
                  <div className="mt-1 text-[10px] text-zinc-500">
                    default {v.defaultWidthMm}×{v.defaultHeightMm} mm
                  </div>
                </button>
              ))}
            </div>
          </details>
        )}
      </Section>

      <Section title="Logo (Customer × Business Area)" wide>
        <p className="mb-3 text-xs text-zinc-500">
          Logo used by templates that render a branded header — currently{" "}
          <code className="font-mono">care-label-01</code>. Upload an{" "}
          <strong>SVG, PNG, or JPG</strong> (drop a file anywhere in this section), or paste SVG
          markup directly. Stored per ProdSpec so the same Customer can have different logos per
          Business Area.
        </p>
        <div
          onDragEnter={onLogoDragEnter}
          onDragLeave={onLogoDragLeave}
          onDragOver={onLogoDragOver}
          onDrop={onLogoDrop}
          className={`relative grid grid-cols-2 gap-4 rounded-md p-3 transition ${
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
                rows={8}
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-[10px]"
                placeholder={"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 30\">…</svg>"}
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
            <div className="mt-1 flex h-32 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
              {logoSvg ? (
                logoSvg.trim().startsWith("data:") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoSvg.trim()}
                    alt="logo preview"
                    className="max-h-24 max-w-[12rem] object-contain"
                  />
                ) : (
                  <div
                    className="max-h-24 max-w-[12rem] [&_svg]:h-full [&_svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: logoSvg }}
                  />
                )
              ) : (
                <span className="text-xs text-zinc-500">no logo set</span>
              )}
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              In <code>care-label-01</code> the logo renders at <strong>~16×7 mm</strong> at the top
              of each label. For a crisp print, upload <strong>SVG</strong> (vector, preferred) or a
              transparent <strong>PNG at ~400×175 px</strong> (≈16:7 aspect). JPG works but can&apos;t
              be transparent. Max 256&nbsp;KB for SVG, 2&nbsp;MB for PNG/JPG.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Output languages" wide>
        <p className="mb-3 text-xs text-zinc-500">
          Languages this prod spec&apos;s outputs render (care labels, info area, …).
          Each language&apos;s text is pulled from the synced Translation board. Leave
          all off to fall back to the template&apos;s built-in default set. Manage the
          list at <code className="font-mono">/languages</code>, or toggle across all
          prod specs on the <code className="font-mono">/prod-specs/languages</code> matrix.
        </p>
        {props.availableLanguages.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            No active languages — visit <code className="font-mono">/languages</code> and click{" "}
            <strong>Seed standard set</strong>.
          </p>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOutputLangs(new Set(props.availableLanguages.map((l) => l.code)))}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setOutputLangs(new Set())}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Clear
              </button>
              <span className="text-xs text-zinc-500">{outputLanguageList.length} selected</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {props.availableLanguages.map(({ code, name }) => (
                <Toggle
                  key={code}
                  checked={outputLangs.has(code)}
                  onChange={(next) => toggleLang(code, next)}
                  label={`${name} (${code})`}
                />
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title="Care instructions — generated from the standard" wide>
        <p className="mb-3 text-xs text-zinc-500">
          The printed care text composes from the central catalogue at{" "}
          <code className="font-mono">/settings/care-labels</code>: every active line, filtered per
          product by the style&apos;s wash-care symbols (a prohibition symbol drops same-action
          lines), translated per language from the Translation board. Nothing is typed per prod
          spec — tune the catalogue, and every output follows. A per-language <em>override</em>{" "}
          replaces the standard verbatim; it&apos;s available below each line, loudly badged.
        </p>
        {props.availableLanguages.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            No active languages — visit <code className="font-mono">/languages</code> and click{" "}
            <strong>Seed standard set</strong> to populate the editor.
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
      </Section>

      <Section title="Suppliers attached" wide>
        {props.allSuppliers.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No active suppliers yet. Sync the Supplier mirror from /monday?tab=sync first.
          </p>
        ) : (
          <>
            <Combobox
              mode="multi"
              options={props.allSuppliers.map((s) => ({
                value: s.id,
                label: s.name,
                hint: s.country ?? undefined,
              }))}
              value={supplierIdList}
              onChange={(ids) => setSupplierIds(new Set(ids))}
              placeholder="Search suppliers…"
              emptyLabel="No matching suppliers"
            />
            <p className="mt-1 text-xs text-zinc-500">
              {supplierIdList.length === 0
                ? "No suppliers attached yet — pick one or more from the list."
                : `${supplierIdList.length} attached.`}
            </p>
          </>
        )}
      </Section>

      <Section title="Column mapping (overrides Customer)" wide>
        <textarea
          value={columnMappingText}
          onChange={(e) => setColumnMappingText(e.target.value)}
          rows={10}
          spellCheck={false}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
        />
      </Section>

      <Section title="Required fields (overrides Customer)" wide>
        <textarea
          value={requiredFieldsText}
          onChange={(e) => setRequiredFieldsText(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
        />
        <p className="mt-1 text-xs text-zinc-500">
          Leave as <code>[]</code> to inherit the Customer-level required fields.
        </p>
      </Section>

      {/* Auto-save handles persistence — there's no submit button. The
          sticky `SaveStatusBar` at the top reflects the latest state and
          exposes a manual "Save now" if the operator wants to flush
          before the debounce fires. */}
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

function SaveStatusBar({
  status,
  savedAt,
  error,
  onSaveNow,
}: {
  status: SaveStatus;
  savedAt: string | null;
  error: string | null;
  onSaveNow: () => void;
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
        return "border-zinc-200 bg-zinc-50 text-zinc-700";
      case "saved":
      case "idle":
        return "border-emerald-200 bg-emerald-50 text-emerald-800";
      case "dirty":
        return "border-amber-200 bg-amber-50 text-amber-900";
      case "error":
        return "border-red-200 bg-red-50 text-red-800";
    }
  })();

  return (
    <div
      className={`sticky top-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs ${tone}`}
    >
      <div className="flex items-center gap-2 min-w-0">
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
        <span className="truncate">{label}</span>
      </div>
      <button
        type="button"
        onClick={onSaveNow}
        disabled={status === "saving"}
        className="flex-shrink-0 rounded border border-current/30 px-2 py-1 text-xs font-medium hover:bg-white/40 disabled:opacity-50"
      >
        Save now
      </button>
    </div>
  );
}

function Section({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h2>
      <div className={wide ? "" : "grid grid-cols-3 gap-4"}>{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-xs font-medium text-zinc-700">
      {label}
      {children}
      {hint && <span className="mt-1 block font-normal text-zinc-500">{hint}</span>}
    </label>
  );
}
