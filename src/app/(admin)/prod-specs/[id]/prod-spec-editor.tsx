"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import type { BundlePageSettings, PageSettings, ProdSpecOutput } from "@/lib/prod-spec/config";
import {
  PINNABLE_FIELDS,
  PINNABLE_FIELD_LABELS,
  parseFieldOverrides,
  type PinnableField,
} from "@/lib/pdf/pins-meta";
import { Toggle } from "@/components/toggle";
import { Combobox } from "@/components/ui/combobox";
import { LazyOutputPreview, normalize as normalizePreviewHtml } from "@/components/output-preview";
import { buttonClass } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { ChevronRight, FileText, LayoutTemplate, MoreHorizontal, Pin, Plus, X } from "lucide-react";
import { MarkdownEditor } from "@/components/markdown-editor";
import { PageSettingsFields } from "./page-settings-fields";
import {
  CareStandardPanel,
  type PanelCareLabel,
  type PanelSymbol,
} from "./care-standard-panel";
import { AddOutputPicker, type VariantInfo } from "./add-output-picker";
import { RerunStylesPanel } from "./rerun-styles-panel";
import type { ProdSpecStyleRunList } from "@/lib/outputs/prod-spec-rerun";
import { ApproveStylesPanel, type ApprovalPanelStyle } from "./approve-styles-panel";
import { ApproveRejectedDialog } from "./approve-rejected-dialog";
import { TestPanel, type TestStyle } from "./test-panel";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type Tab = "general" | "cover" | "outputs" | "styles" | "test";

// Debounce window before the auto-saver flushes a payload. Long enough
// to coalesce rapid typing in the markdown / care-instruction textareas,
// short enough to feel automatic.
const AUTOSAVE_DEBOUNCE_MS = 1200;

type Props = {
  prodSpecId: string;
  // Customer · business area · last update, under the name.
  meta: string;
  // Styles linked to this prod spec — populate the Test tab's style picker.
  styles: TestStyle[];
  initialTab: Tab;
  initialName: string;
  initialActive: boolean;
  initialFullyApproved: boolean;
  initialCoverOnly: boolean;
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
  // All live styles under this spec (capped, most recent first) with their
  // output rollups — the supplier-grouped approval card on the General tab.
  approvalStyles: ApprovalPanelStyle[];
  approvalStylesTotal: number;
};

export function ProdSpecEditor(props: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(props.initialTab);
  const [name, setName] = useState(props.initialName);
  const [active, setActive] = useState(props.initialActive);
  const [fullyApproved, setFullyApproved] = useState(props.initialFullyApproved);
  const [coverOnly, setCoverOnly] = useState(props.initialCoverOnly);
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
  // Turning "Fully approved" ON is intercepted by a confirm dialog (approve +
  // re-run the spec's rejected PDFs) rather than flipping the flag silently.
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  // Latest run list from the RerunStylesPanel (the only fetcher) — its
  // `byOutput` drives the per-output "Run all (N)" buttons on the rows.
  const [runList, setRunList] = useState<ProdSpecStyleRunList | null>(null);
  // The output whose "Run all" is mid-enqueue (base variantKey), + last error.
  const [runningOutput, setRunningOutput] = useState<string | null>(null);
  const [outputRunError, setOutputRunError] = useState<{ key: string; message: string } | null>(null);
  // A per-output run's batch id, handed to the panel so its progress card
  // watches it. Bumps on every scoped run (each returns a fresh id).
  const [adoptBatchId, setAdoptBatchId] = useState<string | null>(null);
  // The Outputs card's catalogue (Add output), which rows have their settings
  // open, and the care section (opened from the side card's Edit).
  const [adding, setAdding] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [careOpen, setCareOpen] = useState(false);

  // Toggle handler: ON is deferred to the dialog (it persists the flag itself
  // via the approve-rejected route); OFF flips instantly through the autosaver.
  function handleFullyApprovedChange(next: boolean) {
    if (next && !fullyApproved) {
      setApproveDialogOpen(true);
    } else {
      setFullyApproved(next);
    }
  }

  // Per-output "Run all": regenerate THIS output across every style attached to
  // the spec where it isn't approved (new/missing, rejected, or awaiting review).
  // Enqueues a scoped background batch; the "Run styles" panel adopts its id and
  // shows the progress. Gated the same way as the panel's spec-wide run — must
  // read PERSISTED outputs (not dirty) and the spec must be active.
  async function runOutputAll(variantKey: string, outputName: string) {
    const count = runList?.byOutput?.[variantKey]?.toRun ?? 0;
    const parked = runList?.byOutput?.[variantKey]?.belowCutoff ?? 0;
    if (count <= 0 || runningOutput || status === "dirty" || status === "saving" || !active) return;
    const ok = window.confirm(
      `Run “${outputName}” on ${count} style${count === 1 ? "" : "s"}?\n\n` +
        (parked > 0
          ? `${parked} style(s) below the generation PO cutoff are left out — parked backlog.\n\n`
          : "") +
        `Runs this output on every style where it isn't approved (new/missing, rejected, ` +
        `awaiting review). Approved work is left alone. Renders in the background; progress ` +
        `shows in “Run styles” below.`,
    );
    if (!ok) return;
    setRunningOutput(variantKey);
    setOutputRunError(null);
    try {
      const res = await fetch(`/api/admin/prod-specs/${props.prodSpecId}/rerun-styles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKey }),
      });
      const data = (await res.json().catch(() => ({}))) as { batchId?: string | null; error?: string };
      if (!res.ok) {
        setOutputRunError({ key: variantKey, message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      if (data.batchId) setAdoptBatchId(data.batchId);
      else setOutputRunError({ key: variantKey, message: "Nothing to run — styles may have started elsewhere." });
    } catch (e) {
      setOutputRunError({ key: variantKey, message: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setRunningOutput(null);
    }
  }

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
      fullyApproved,
      coverOnly,
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
      fullyApproved,
      coverOnly,
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

  // Flush any pending (debounced) autosave before a test generation so the
  // rendered PDFs reflect the latest edits. No-op when already in sync.
  async function flushIfDirty(): Promise<void> {
    if (JSON.stringify(payload) !== lastSavedPayloadRef.current) {
      await save();
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
  const unsaved = status === "dirty" || status === "saving";

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: "outputs", label: "Outputs", count: enabledCount },
    { key: "general", label: "General information" },
    { key: "cover", label: "Cover page" },
    { key: "styles", label: "Styles & approval", count: props.approvalStylesTotal },
    { key: "test", label: "Test" },
  ];

  function toggleRow(key: string) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // "Edit" on the side card opens the care section in the main column and
  // brings it into view.
  function openCare() {
    setCareOpen(true);
    window.setTimeout(() => {
      document.getElementById("care-instructions")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  return (
    <div className="flex flex-col">
      {approveDialogOpen && (
        <ApproveRejectedDialog
          prodSpecId={props.prodSpecId}
          onClose={() => setApproveDialogOpen(false)}
          onConfirmed={() => setFullyApproved(true)}
        />
      )}
      <SpecHeader
        meta={props.meta}
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
        fullyApproved={fullyApproved}
        onFullyApproved={handleFullyApprovedChange}
      />

      <nav aria-label="Prod spec" className="border-line mt-4 flex gap-5 overflow-x-auto border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-[13px] transition-colors duration-150 ${
              tab === t.key ? "border-ink text-ink font-medium" : "text-muted hover:text-ink border-transparent"
            }`}
          >
            {t.label}
            {t.count !== undefined && <span className="text-faint text-[12px] font-normal tabular-nums">{t.count}</span>}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {tab === "general" ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card
              title="General information"
              description="Requirements, inspection standards, packing rules — written once, printed right after the cover of every bundle."
            >
              <div className="p-4">
                <MarkdownEditor
                  value={generalInfoMd}
                  onChange={setGeneralInfoMd}
                  uploadUrl={`/api/admin/prod-specs/${props.prodSpecId}/images`}
                />
                <p className="text-faint mt-2 text-[11px]">
                  Type <code className="font-mono">#</code> and a space for a heading,{" "}
                  <code className="font-mono">-</code> and a space for a list; tables and images insert from the
                  toolbar. Long content flows onto further A4 pages. Left empty, no page is added.
                </p>
              </div>
            </Card>
            <div className="flex flex-col gap-4">
              <Card title="Page settings · general information" description="How these pages print">
                <div className="p-4">
                  <PageSettingsFields
                    value={pageSettings.generalInfo}
                    onChange={(generalInfo: PageSettings) => setPageSettings((prev) => ({ ...prev, generalInfo }))}
                  />
                </div>
              </Card>
              <Card title="A4 preview" description="Refreshes after each save">
                <div className="bg-canvas p-3">
                  <LazyOutputPreview
                    src={`/api/admin/prod-specs/${props.prodSpecId}/general-info-preview`}
                    widthMm={210}
                    heightMm={297}
                    refreshKey={savedAt ?? undefined}
                  />
                </div>
              </Card>
            </div>
          </div>
        ) : tab === "cover" ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card title="Preview" description="Refreshes after each save">
              <div className="bg-canvas p-4">
                <div className="mx-auto max-w-2xl">
                  <LazyOutputPreview
                    src={`/api/admin/prod-specs/${props.prodSpecId}/cover-preview`}
                    widthMm={210}
                    heightMm={297}
                    refreshKey={savedAt ?? undefined}
                  />
                </div>
              </div>
            </Card>
            <div className="flex flex-col gap-4">
              <Card title="Cover page" description="Auto-generated, first page of every bundle">
                <p className="text-muted px-4 py-3 text-[12px]">
                  Each enabled output&apos;s title and size, once, then the General information pages in the same
                  document. The content follows the Outputs and General information tabs; a run builds the real
                  one from the documents it actually generated.
                </p>
              </Card>
              <Card title="Page settings · cover page" description="How the cover sheet prints">
                <div className="p-4">
                  <PageSettingsFields
                    value={pageSettings.cover}
                    onChange={(cover: PageSettings) => setPageSettings((prev) => ({ ...prev, cover }))}
                  />
                </div>
              </Card>
            </div>
          </div>
        ) : tab === "styles" ? (
          <div className="flex flex-col gap-4">
            <ApproveStylesPanel
              prodSpecId={props.prodSpecId}
              styles={props.approvalStyles}
              totalCount={props.approvalStylesTotal}
            />
            <RerunStylesPanel
              prodSpecId={props.prodSpecId}
              specActive={active}
              unsaved={unsaved}
              onList={setRunList}
              adoptBatchId={adoptBatchId}
            />
          </div>
        ) : tab === "test" ? (
          <TestPanel
            prodSpecId={props.prodSpecId}
            styles={props.styles}
            enabledOutputCount={enabledCount}
            hasGeneralInfo={generalInfoMd.trim().length > 0}
            flush={flushIfDirty}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-4">
              <Card
                title="Outputs"
                description="Generated for every style on this spec, unless a rule says otherwise. Cover and general information are their own tabs."
                actions={
                  unaddedVariants.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setAdding((a) => !a)}
                      aria-expanded={adding}
                      className={buttonClass("secondary", "sm")}
                    >
                      {adding ? <X size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
                      {adding ? "Done adding" : "Add output"}
                    </button>
                  ) : null
                }
              >
                {adding && unaddedVariants.length > 0 ? (
                  <AddOutputPicker
                    open
                    variants={unaddedVariants}
                    prodSpecId={props.prodSpecId}
                    onAdd={addOutput}
                    previewRefreshKey={savedAt ?? undefined}
                  />
                ) : null}
                {outputs.length === 0 ? (
                  <p
                    className={`m-4 rounded-md p-3 text-[12px] ${coverOnly ? "bg-subtle text-muted" : "bg-warn-soft text-warn"}`}
                  >
                    {coverOnly
                      ? "Cover page only: a run makes the cover and nothing else."
                      : "No outputs yet. A run fails with “no Outputs configured” until you add one, or tick Cover page only below."}
                  </p>
                ) : (
                  <ul className="divide-line divide-y">
                    {outputs.map((o, i) => {
                      const v = variantByKey.get(o.variantKey);
                      const label = v?.name ?? o.variantKey;
                      const pinCount = Object.keys(parseFieldOverrides(o.fieldOverrides)).length;
                      // Output Builder layouts (variantKey `layout:<id>`) open in
                      // their own editor; built-in variants have no page of their own.
                      const layoutId = layoutIdFromVariantKey(o.variantKey);
                      const summary = runList?.byOutput?.[o.variantKey];
                      const open = openRows.has(o.variantKey);
                      const previewSrc = `/api/admin/prod-specs/${props.prodSpecId}/output-preview?variantKey=${encodeURIComponent(o.variantKey)}`;
                      return (
                        <li key={`${o.variantKey}-${i}`} className={o.enabled ? "" : "bg-subtle/60"}>
                          <div className="flex flex-wrap items-start gap-3 px-4 py-3 md:flex-nowrap">
                            <OutputThumb
                              src={previewSrc}
                              widthMm={o.widthMm}
                              heightMm={o.heightMm}
                              refreshKey={savedAt ?? undefined}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-ink truncate text-[13px] font-medium" title={v?.description}>
                                  {label}
                                </span>
                                {!o.enabled ? (
                                  <Pill title="Switched off: runs skip this output">Off</Pill>
                                ) : null}
                              </div>
                              <div className="text-muted mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[12px]">
                                <span>{v ? v.docTypeLabel : <span className="text-bad">Unknown variant</span>}</span>
                                <span className="tabular-nums">
                                  {o.widthMm} × {o.heightMm} mm
                                </span>
                                <span className="text-faint truncate font-mono text-[11px]">{o.variantKey}</span>
                              </div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {pinCount > 0 ? (
                                  <Pill title="Fields this output always prints with a fixed value">
                                    <Pin size={10} aria-hidden="true" />
                                    {pinCount} pinned
                                  </Pill>
                                ) : null}
                                {summary && summary.applies > 0 ? (
                                  <span
                                    className="text-muted inline-flex items-center gap-1.5 text-[12px]"
                                    title={`Approved on ${summary.approved} of the ${summary.applies} styles this output applies to`}
                                  >
                                    <span className="bg-subtle flex h-1.5 w-14 overflow-hidden rounded-full">
                                      <span
                                        className="bg-good h-full"
                                        style={{ width: `${Math.round((summary.approved / summary.applies) * 100)}%` }}
                                      />
                                    </span>
                                    <span className="tabular-nums">
                                      {summary.approved}/{summary.applies} approved
                                    </span>
                                  </span>
                                ) : null}
                              </div>
                              {outputRunError?.key === o.variantKey && (
                                <p className="text-bad mt-1 text-[11px]">{outputRunError.message}</p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              {/* Carton barcode: EAN-128 = Code 128 bars with the
                                  number beneath (the default); EAN-13 = digits
                                  inside the symbol. */}
                              {v?.docType === "CARTON_MARKING" && (
                                <select
                                  value={o.cartonBarcodeType ?? "ean128"}
                                  onChange={(e) =>
                                    updateOutput(i, {
                                      cartonBarcodeType: e.target.value === "ean13" ? "ean13" : undefined,
                                    })
                                  }
                                  aria-label={`Carton barcode for ${label}`}
                                  className="border-line bg-surface text-ink focus:border-accent h-7 rounded-md border px-2 text-[12px] outline-none"
                                >
                                  <option value="ean128">EAN-128 (Code 128)</option>
                                  <option value="ean13">EAN-13</option>
                                </select>
                              )}
                              {layoutId ? (
                                <Link
                                  href={`/output-builder/${layoutId}`}
                                  title={`Open “${label}” in the Output Builder`}
                                  className={buttonClass("secondary", "sm")}
                                >
                                  <LayoutTemplate size={13} aria-hidden="true" />
                                  Open layout
                                </Link>
                              ) : null}
                              <OutputRunAllButton
                                summary={summary}
                                listLoaded={runList !== null}
                                running={runningOutput === o.variantKey}
                                busy={runningOutput !== null}
                                unsaved={unsaved}
                                specActive={active}
                                onRun={() => void runOutputAll(o.variantKey, label)}
                              />
                              <button
                                type="button"
                                onClick={() => toggleRow(o.variantKey)}
                                aria-expanded={open}
                                aria-label={`More for ${label}`}
                                title="On/off, size, pinned fields, preview, remove"
                                className={buttonClass("ghost", "sm", "px-1.5")}
                              >
                                <MoreHorizontal size={15} aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                          {open ? (
                            <div className="border-line bg-subtle/40 flex flex-col gap-3 border-t px-4 py-3">
                              <div className="text-muted flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
                                <Toggle
                                  checked={o.enabled}
                                  onChange={(next) => updateOutput(i, { enabled: next })}
                                  label="Generate this output"
                                  size="sm"
                                />
                                <label className="flex items-center gap-1">
                                  Size
                                  <input
                                    type="number"
                                    step={0.1}
                                    min={1}
                                    value={o.widthMm}
                                    onChange={(e) => updateOutput(i, { widthMm: Number(e.target.value) })}
                                    className="border-line bg-surface text-ink h-7 w-16 rounded-md border px-2 text-[12px] tabular-nums"
                                    aria-label="Width mm"
                                  />
                                  ×
                                  <input
                                    type="number"
                                    step={0.1}
                                    min={1}
                                    value={o.heightMm}
                                    onChange={(e) => updateOutput(i, { heightMm: Number(e.target.value) })}
                                    className="border-line bg-surface text-ink h-7 w-16 rounded-md border px-2 text-[12px] tabular-nums"
                                    aria-label="Height mm"
                                  />
                                  mm
                                </label>
                                {v?.docType === "CARTON_MARKING" && (
                                  <label className="flex items-center gap-1" title="Overrides the renderer's default bar height">
                                    Bar height
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
                                      className="border-line bg-surface text-ink h-7 w-16 rounded-md border px-2 text-[12px] tabular-nums"
                                    />
                                    mm
                                  </label>
                                )}
                                <span className="flex-1" />
                                <button
                                  type="button"
                                  onClick={() => removeOutput(i)}
                                  className={buttonClass("danger", "sm")}
                                >
                                  Remove output
                                </button>
                              </div>
                              <PinControls
                                overrides={o.fieldOverrides}
                                onChange={(fieldOverrides) => updateOutput(i, { fieldOverrides })}
                              />
                              {/* A sample wearing THIS spec's config (logo, languages,
                                  care override, pins, size). Refetches after each save. */}
                              <div className="bg-canvas rounded-md p-3">
                                <LazyOutputPreview
                                  src={previewSrc}
                                  widthMm={o.widthMm}
                                  heightMm={o.heightMm}
                                  refreshKey={savedAt ?? undefined}
                                />
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <section
                data-section="Cover page only"
                className="border-line bg-surface rounded-xl border px-4 py-3"
              >
                <label className="flex items-start gap-2.5 text-[13px]">
                  <input
                    type="checkbox"
                    checked={coverOnly}
                    onChange={(e) => setCoverOnly(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-ink font-medium">Cover page only — the customer supplies every layout</span>
                    <span className="text-muted mt-0.5 block text-[12px]">
                      A run makes the cover and nothing else; the artwork arrives through the upload zones on each
                      style&apos;s Review tab. Left off, an empty Outputs list is treated as a mistake and a run
                      fails rather than quietly producing a bare cover.
                    </span>
                  </span>
                </label>
              </section>

              <Collapsible
                title="Logo"
                summary={<SummaryChip>{logoSvg.trim() ? "Set" : "None"}</SummaryChip>}
              >
                <p className="text-muted mb-2 text-[12px]">
                  Customer × business area, for templates with a branded header — currently{" "}
                  <code className="font-mono">care-label-01</code> (~16×7 mm at the top of each label). Upload an SVG,
                  PNG or JPG (or drop it here), or paste SVG markup. SVG preferred; PNG at ~400×175 px works; max
                  256&nbsp;KB SVG / 2&nbsp;MB raster.
                </p>
                <div
                  onDragEnter={onLogoDragEnter}
                  onDragLeave={onLogoDragLeave}
                  onDragOver={onLogoDragOver}
                  onDrop={onLogoDrop}
                  className={`relative grid grid-cols-1 gap-4 rounded-md p-2 transition sm:grid-cols-2 ${
                    dragOver ? "ring-accent ring-4 ring-offset-2" : ""
                  }`}
                >
                  {dragOver && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-zinc-900/5">
                      <div className="border-ink text-ink rounded-md border-2 border-dashed bg-white/95 px-6 py-3 text-sm font-medium">
                        Drop SVG, PNG, or JPG to attach
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="text-ink text-[12px] font-medium">
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
                    <label className="text-ink mt-3 block text-[12px] font-medium">
                      Or paste SVG markup
                      <textarea
                        value={logoSvg}
                        onChange={(e) => setLogoSvg(e.target.value)}
                        rows={5}
                        spellCheck={false}
                        className="border-line mt-1 w-full rounded-md border px-3 py-2 font-mono text-[11px]"
                        placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30">…</svg>'}
                      />
                    </label>
                    {logoSvg && (
                      <button type="button" onClick={() => setLogoSvg("")} className="text-bad mt-2 text-xs underline">
                        Clear logo
                      </button>
                    )}
                    {logoErr && <p className="text-bad mt-2 text-xs">{logoErr}</p>}
                  </div>
                  <div>
                    <div className="text-ink text-[12px] font-medium">Preview</div>
                    <div className="border-line bg-subtle mt-1 flex h-24 items-center justify-center rounded-md border">
                      {logoSvg ? (
                        logoSvg.trim().startsWith("data:") ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logoSvg.trim()} alt="logo preview" className="max-h-20 max-w-[12rem] object-contain" />
                        ) : (
                          <div
                            className="max-h-20 max-w-[12rem] [&_svg]:h-full [&_svg]:w-full"
                            dangerouslySetInnerHTML={{ __html: logoSvg }}
                          />
                        )
                      ) : (
                        <span className="text-muted text-xs">no logo set</span>
                      )}
                    </div>
                  </div>
                </div>
              </Collapsible>

              <Collapsible
                id="care-instructions"
                title="Care instructions"
                summary={
                  <SummaryChip tone={careOverrideCount > 0 ? "warn" : "default"}>
                    {careOverrideCount === 0 ? "From the standard" : `${careOverrideCount} language override(s)`}
                  </SummaryChip>
                }
                open={careOpen}
                onOpenChange={setCareOpen}
              >
                <p className="text-muted mb-2 text-[12px]">
                  The printed care text composes from the central catalogue: every active line, filtered per product
                  by the style&apos;s wash-care symbols, translated per language from the Translation board. A
                  per-language <em>override</em> replaces the standard verbatim; it&apos;s available below each line,
                  loudly badged.
                </p>
                {props.availableLanguages.length === 0 ? (
                  <p className="bg-warn-soft text-warn rounded-md p-3 text-xs">
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
                    onChangeCareByLang={(code, value) => setCareByLang((prev) => ({ ...prev, [code]: value }))}
                  />
                )}
              </Collapsible>

              {hasHiddenOverrides && (
                <div className="border-line bg-subtle text-muted rounded-lg border border-dashed px-4 py-3 text-xs">
                  <span className="text-muted font-medium">Managed outside this editor now:</span> suppliers, column
                  mapping and required fields.{" "}
                  <span className="inline-flex flex-wrap gap-1.5 align-middle">
                    {props.attachedSupplierCount > 0 && (
                      <SummaryChip>{props.attachedSupplierCount} supplier(s) attached</SummaryChip>
                    )}
                    {props.hasColumnMappingOverride && (
                      <SummaryChip tone="warn">Carries column-mapping override</SummaryChip>
                    )}
                    {props.hasRequiredFieldsOverride && (
                      <SummaryChip tone="warn">Carries required-fields override</SummaryChip>
                    )}
                  </span>{" "}
                  Stored values still apply at render time.
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <Card title="Languages" description="Which languages the outputs print">
                <div className="flex flex-col gap-2 p-4">
                  {props.availableLanguages.length === 0 ? (
                    <p className="bg-warn-soft text-warn rounded-md p-3 text-xs">
                      No active languages — visit <code className="font-mono">/languages</code> and click{" "}
                      <strong>Seed standard set</strong>.
                    </p>
                  ) : (
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
                  )}
                  <p className="text-faint text-[11px]">
                    Pulled from the synced Translation board. Left empty, each template prints its own default set.
                    The <Link href="/prod-specs/languages" className="underline">languages matrix</Link> sets them
                    across every prod spec.
                  </p>
                </div>
              </Card>
              <Card title="Re-run styles" description="After you fix the spec or a layout">
                <div className="p-4">
                  <RerunStylesPanel
                    compact
                    prodSpecId={props.prodSpecId}
                    specActive={active}
                    unsaved={unsaved}
                    onList={setRunList}
                    adoptBatchId={adoptBatchId}
                  />
                </div>
              </Card>
              <Card
                title="Care standard"
                description={`${props.careLabels.length} care lines, filtered per style by its wash symbols`}
                actions={
                  <button type="button" onClick={openCare} className={buttonClass("ghost", "sm")}>
                    Edit
                  </button>
                }
              >
                <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-[12px]">
                  {careOverrideCount > 0 ? (
                    <Pill tone="warn">{careOverrideCount} language override(s)</Pill>
                  ) : (
                    <span className="text-muted">Every language follows the standard.</span>
                  )}
                  <Link href="/settings/care-labels" className="text-accent-text ml-auto hover:underline">
                    Catalogue
                  </Link>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Per-output pin editor: existing pins as chips with one-click unpin, plus
// a field+value picker to add one. E.g. "Customer name (printed) = Netto A/S"
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
        <span className="text-[11px] font-medium text-faint">Pins</span>
        {pinnedKeys.length === 0 && (
          <span className="text-[11px] text-faint">none — every field follows the row</span>
        )}
        {pinnedKeys.map((key) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink"
            title="Pinned — always this value on this output, regardless of the Monday row"
          >
            <PinIcon className="h-3 w-3 shrink-0 text-faint" />
            {PINNABLE_FIELD_LABELS[key]} = {pins[key]}
            <button
              type="button"
              onClick={() => remove(key)}
              className="ml-0.5 inline-flex text-faint hover:text-bad"
              aria-label={`Unpin ${PINNABLE_FIELD_LABELS[key]}`}
            >
              <XIcon className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={field}
          onChange={(e) => setField(e.target.value as PinnableField | "")}
          className="h-7 rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent disabled:opacity-50"
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
              className="w-56 rounded-md border border-line px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={add}
              disabled={!value.trim()}
              className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
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

// The page header: the editable name with its save state, the spec's
// customer line, and the three workflow knobs on the right.
function SpecHeader({
  meta,
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
  fullyApproved,
  onFullyApproved,
}: {
  meta: string;
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
  fullyApproved: boolean;
  onFullyApproved: (v: boolean) => void;
}) {
  const label = (() => {
    switch (status) {
      case "saving":
        return "Saving…";
      case "dirty":
        return "Unsaved · saving shortly";
      case "error":
        return error ? `Couldn't save: ${error}` : "Couldn't save";
      case "saved":
      case "idle":
      default:
        return savedAt ? `Saved ${savedAt} · auto-save on` : "Saved · auto-save on";
    }
  })();
  const dot =
    status === "saving" ? "animate-pulse bg-faint" : status === "dirty" ? "bg-warn" : status === "error" ? "bg-bad" : "bg-good";

  return (
    <div data-section="Page header" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-[1_1_20rem]">
        <nav aria-label="Breadcrumb" className="text-muted mb-1 flex items-center gap-1 text-[12px]">
          <Link href="/prod-specs" className="hover:text-ink">
            Prod specs
          </Link>
          <span className="text-faint" aria-hidden="true">
            /
          </span>
        </nav>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The input sizes to its text: an invisible copy of the name sits
              in the same grid cell and sets the width. */}
          <h1 className="-ml-1.5 inline-grid max-w-full min-w-0 text-[18px] font-semibold tracking-[-0.01em]">
            <span aria-hidden="true" className="invisible col-start-1 row-start-1 truncate border border-transparent px-1.5 whitespace-pre">
              {name || "Name"}{" "}
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => onName(e.target.value)}
              required
              aria-label="Prod spec name"
              className="text-ink hover:border-line focus:border-accent col-start-1 row-start-1 h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 outline-none"
            />
          </h1>
          <span role="status" className="text-muted inline-flex min-w-0 items-center gap-1.5 text-[12px]">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className={`max-w-[28rem] truncate ${status === "error" ? "text-bad" : ""}`} title={label}>
              {label}
            </span>
            {status === "dirty" || status === "error" ? (
              <button type="button" onClick={onSaveNow} className="text-ink shrink-0 underline">
                Save now
              </button>
            ) : null}
          </span>
        </div>
        <p className="text-muted mt-0.5 text-[13px]">{meta}</p>
      </div>
      <div className="text-muted flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        <label className="flex items-center gap-1.5" title="Completion % at which a style auto-enqueues a generation job">
          Auto-runs at
          <input
            type="number"
            min={0}
            max={100}
            value={threshold}
            onChange={(e) => onThreshold(Math.max(0, Math.min(100, Number(e.target.value))))}
            className="border-line bg-surface text-ink focus:border-accent h-7 w-14 rounded-md border px-2 text-[12px] tabular-nums outline-none"
          />
          %
        </label>
        <Toggle checked={active} onChange={onActive} label="Active" size="sm" />
        <span title="Every style is approved for every output">
          <Toggle checked={fullyApproved} onChange={onFullyApproved} label="Fully approved" size="sm" />
        </span>
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section data-section={title} className="border-line bg-surface overflow-hidden rounded-xl border">
      <div className={`border-line flex items-start justify-between gap-3 px-4 py-3 ${children ? "border-b" : ""}`}>
        <div className="min-w-0">
          <h2 className="text-ink text-[14px] font-semibold">{title}</h2>
          {description ? <p className="text-muted text-[12px]">{description}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// A card that folds: the print settings that feed rendering but are rarely
// touched stay one line until opened. `open` makes it controlled.
function Collapsible({
  id,
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  id?: string;
  title: string;
  summary?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      open={open}
      onToggle={(e) => onOpenChange?.(e.currentTarget.open)}
      data-section={title}
      className="group border-line bg-surface scroll-mt-16 overflow-hidden rounded-xl border"
    >
      <summary className="hover:bg-subtle/60 flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} aria-hidden="true" className="text-faint transition-transform group-open:rotate-90" />
        <span className="text-ink text-[14px] font-semibold">{title}</span>
        {summary}
      </summary>
      <div className="border-line border-t p-4">{children}</div>
    </details>
  );
}

// A small live render of one output wearing this spec's settings, fitted into
// a square — the same preview the row's settings show in full.
const THUMB_PX = 64;
const MM_PX = 96 / 25.4;

function OutputThumb({
  src,
  widthMm,
  heightMm,
  refreshKey,
}: {
  src: string;
  widthMm: number;
  heightMm: number;
  refreshKey?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(src, { cache: "no-store" })
      .then(async (res) => {
        // A static-PDF output answers 409 with JSON — no HTML to draw.
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) throw new Error("no preview");
        const text = await res.text();
        if (!cancelled) {
          setHtml(text);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, refreshKey]);

  const w = Math.max(widthMm, 1) * MM_PX;
  const h = Math.max(heightMm, 1) * MM_PX;
  const scale = Math.min(THUMB_PX / w, THUMB_PX / h);
  return (
    <div
      aria-hidden="true"
      className="border-line bg-canvas flex size-[76px] shrink-0 items-center justify-center overflow-hidden rounded-lg border"
    >
      {html ? (
        // Print proofs are always on paper, whatever the theme.
        <div className="overflow-hidden bg-white shadow-[var(--shadow-pop)]" style={{ width: w * scale, height: h * scale }}>
          <iframe
            srcDoc={normalizePreviewHtml(html, widthMm, heightMm)}
            title=""
            tabIndex={-1}
            scrolling="no"
            style={{
              width: w,
              height: h,
              border: "none",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              pointerEvents: "none",
              display: "block",
              background: "white",
            }}
          />
        </div>
      ) : failed ? (
        <FileText size={18} className="text-faint" />
      ) : (
        <div className="skeleton size-10 rounded" />
      )}
    </div>
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
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        tone === "warn"
          ? "border-transparent bg-warn-soft text-warn"
          : "border-line bg-surface text-muted"
      }`}
    >
      {children}
    </span>
  );
}

// Per-output "Run all" — regenerates one output across every attached style
// that needs it (new/missing + rejected + changed; approved left alone). The
// count comes from the run list's byOutput; the actual enqueue + progress live
// in the RerunStylesPanel below. Disabled (with a reason) while the spec is
// dirty/inactive, the list is loading, or nothing needs this output.
function OutputRunAllButton({
  summary,
  listLoaded,
  running,
  busy,
  unsaved,
  specActive,
  onRun,
}: {
  summary:
    | { toRun: number; missing: number; rejected: number; changed: number; pending: number; belowCutoff?: number }
    | undefined;
  listLoaded: boolean;
  running: boolean;
  busy: boolean;
  unsaved: boolean;
  specActive: boolean;
  onRun: () => void;
}) {
  const count = summary?.toRun ?? 0;
  // Styles this output needs but that sit below the generation PO cutoff. They
  // are NOT in `count` — the route parks them — so the button says so rather
  // than quietly running fewer styles than its label implies.
  const parked = summary?.belowCutoff ?? 0;
  const disabledReason = unsaved
    ? "Save your output changes first"
    : !specActive
      ? "Activate this prod spec to run its styles"
      : !listLoaded
        ? "Loading styles…"
        : count === 0
          ? parked > 0
            ? `Every in-scope style is approved for this output (${parked} below the PO cutoff — run those from the style page)`
            : "Every style is approved for this output"
          : null;
  const disabled = running || busy || count === 0 || Boolean(disabledReason);
  const prominent = count > 0 && !disabled;
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled}
      title={
        disabledReason ??
        `Run this output on ${count} style${count === 1 ? "" : "s"} where it isn't approved` +
          (summary && summary.changed > 0 ? ` — ${summary.changed} changed since last render` : "")
      }
      className={buttonClass(prominent ? "primary" : "secondary", "sm")}
    >
      {running ? <RowSpinner /> : <RunAllRowIcon />}
      Run all{listLoaded && count > 0 ? ` (${count})` : ""}
    </button>
  );
}

function RunAllRowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function RowSpinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// Inline icons — Lucide-style strokes, matching the SearchIcon/ChevronIcon
// idiom used across the admin pages (no icon dependency in this project).
function XIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function PinIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}
