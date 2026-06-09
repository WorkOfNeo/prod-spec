"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Customer = { id: string; name: string; slug: string };
type Supplier = { id: string; name: string; country: string | null };
type BusinessArea = { id: string; mondayValue: string; name: string };
type WashSymbol = { id: string; code: string; name: string; svg: string | null };
type QrImage = { id: string; name: string; image: string };

// Form state aligned 1:1 with /api/admin/styles/manual (POST) and
// /api/admin/styles/[id] (PATCH). `washSymbolCodes` is an array on the
// client; the API joins/splits to/from the comma-string the synthetic
// Monday column carries.
type FormState = {
  customerId: string;
  supplierId: string;            // "" = none
  businessAreaId: string;        // "" = none (then no ProdSpec resolves)
  styleName: string;
  styleNumber: string;
  businessArea: string;          // raw text fallback; auto-synced from selected BA
  composition: string;
  productNameTranslations: string;
  washSymbolCodes: string[];     // multi-select of WashSymbol.code
  sizes: string;
  ean13: string;
  klNumber: string;
  supplierNumber: string;
  lot: string;
  cartonQty: string;
  cartonEan: string;
  colourName: string;
  colourCode: string;
  price: string;
  supplierEmail: string;
  // "Made in …" on care labels. Defaults to the linked supplier's country
  // when blank; a Monday sync / webhook overwrites a hand-typed value.
  countryOfOrigin: string;
  qrImageId: string;            // "" = none; links Style.qrImageId for Care Label 02 page 4
};

const SAMPLE: Omit<FormState, "customerId" | "supplierId" | "businessAreaId" | "businessArea" | "washSymbolCodes" | "qrImageId"> = {
  styleName: "Classic Crew Tee",
  styleNumber: "12345",
  composition: "EN: 100% Cotton | DE: 100% Baumwolle | FR: 100% Coton",
  productNameTranslations: "EN: Classic Crew Tee | DE: Klassisches Rundhals-T-Shirt | FR: T-shirt Classique",
  sizes: "XS,S,M,L,XL",
  ean13: "XS=4710000000001,S=4710000000018,M=4710000000025,L=4710000000032,XL=4710000000049",
  klNumber: "KL-12345",
  supplierNumber: "SUP-001",
  lot: "LOT-A23",
  cartonQty: "12",
  cartonEan: "4710000000056",
  colourName: "Navy Blue",
  colourCode: "NAVY-001",
  price: "19.99 EUR",
  supplierEmail: "supplier@example.com",
  countryOfOrigin: "India",
};

function makeInitial(customers: Customer[], businessAreas: BusinessArea[]): FormState {
  return {
    customerId: customers[0]?.id ?? "",
    supplierId: "",
    businessAreaId: businessAreas[0]?.id ?? "",
    styleName: "",
    styleNumber: "",
    businessArea: businessAreas[0]?.mondayValue ?? "PL",
    composition: "",
    productNameTranslations: "",
    washSymbolCodes: [],
    sizes: "",
    ean13: "",
    klNumber: "",
    supplierNumber: "",
    lot: "",
    cartonQty: "",
    cartonEan: "",
    colourName: "",
    colourCode: "",
    price: "",
    supplierEmail: "",
    countryOfOrigin: "",
    qrImageId: "",
  };
}

// Lightweight summary of existing ProdSpec rows, indexed by
// (customerId, businessAreaId). Used to render a live "linked ProdSpec"
// preview as the operator picks. `outputsCount` lets us warn when the
// matched ProdSpec has no Outputs configured — the silent footgun that
// causes NO_OUTPUTS errors on first run.
export type ProdSpecSummary = {
  id: string;
  name: string;
  customerId: string;
  businessAreaId: string;
  outputsCount: number;
};

export type ManualStyleFormProps = {
  mode: "create" | "edit";
  styleId?: string;
  customers: Customer[];
  suppliers: Supplier[];
  businessAreas: BusinessArea[];
  washSymbols: WashSymbol[];
  qrImages: QrImage[];
  prodSpecs: ProdSpecSummary[];
  initial?: FormState;
};

export function ManualStyleForm(props: ManualStyleFormProps) {
  const { mode, styleId, customers, suppliers, businessAreas, washSymbols, qrImages, prodSpecs } = props;
  const router = useRouter();
  const [state, setState] = useState<FormState>(
    props.initial ?? makeInitial(customers, businessAreas),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Live preview of which ProdSpec this Style will resolve to once saved.
  // The Style → ProdSpec link is purely a (Customer × BusinessArea) lookup;
  // surface that here so the operator sees the connection at fill time
  // rather than after a confusing NO_OUTPUTS error.
  const matchedProdSpec = (() => {
    if (!state.customerId || !state.businessAreaId) return null;
    return (
      prodSpecs.find(
        (p) => p.customerId === state.customerId && p.businessAreaId === state.businessAreaId,
      ) ?? null
    );
  })();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  // Picking a BusinessArea row updates both the FK and the free-text
  // mirror — the synthetic Monday column needs the text so the sticker
  // template's `LOVED` check (and similar) still works on render.
  function pickBusinessArea(id: string) {
    const ba = businessAreas.find((b) => b.id === id);
    setState((s) => ({
      ...s,
      businessAreaId: id,
      businessArea: ba?.mondayValue ?? s.businessArea,
    }));
  }

  function toggleWashSymbol(code: string) {
    setState((s) => {
      const has = s.washSymbolCodes.includes(code);
      return {
        ...s,
        washSymbolCodes: has
          ? s.washSymbolCodes.filter((c) => c !== code)
          : [...s.washSymbolCodes, code],
      };
    });
  }

  function fillSample() {
    setState((s) => ({
      ...s,
      ...SAMPLE,
      // Pick a sensible default for the new selects without overriding
      // what the user may have already chosen.
      businessAreaId: s.businessAreaId || (businessAreas[0]?.id ?? ""),
      businessArea: s.businessArea || (businessAreas[0]?.mondayValue ?? "PL"),
      washSymbolCodes:
        s.washSymbolCodes.length > 0
          ? s.washSymbolCodes
          : washSymbols
              .filter((w) => ["wash30", "bleach_no", "tumble_low", "iron_medium"].includes(w.code))
              .map((w) => w.code),
    }));
  }

  function clearAll() {
    setState((s) => ({
      ...makeInitial(customers, businessAreas),
      customerId: s.customerId,
    }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = {
        ...state,
        // Normalise empty-string select values to null so the API
        // doesn't try to FK against an empty cuid.
        supplierId: state.supplierId || null,
        businessAreaId: state.businessAreaId || null,
        qrImageId: state.qrImageId || null,
      };
      const url = mode === "create" ? "/api/admin/styles/manual" : `/api/admin/styles/${styleId}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body.error
            ? `${body.error}${body.details ? ` — ${JSON.stringify(body.details)}` : ""}`
            : `HTTP ${res.status}`,
        );
        return;
      }
      router.push(`/styles/${body.styleId}/review`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 max-w-3xl">
      <div className="mb-4 flex gap-2">
        <button
          type="button"
          onClick={fillSample}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
        >
          Fill with sample data
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
        >
          Clear
        </button>
      </div>

      <Section title="Basics">
        <Field label="Customer *">
          <select
            value={state.customerId}
            onChange={(e) => update("customerId", e.target.value)}
            disabled={mode === "edit"}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50 disabled:text-zinc-500"
            required
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <span className="mt-1 block font-normal text-zinc-500">
              Customer is immutable after create. Delete and re-create to reassign.
            </span>
          )}
        </Field>
        <Field label="Style name *">
          <Input value={state.styleName} onChange={(v) => update("styleName", v)} required />
        </Field>
        <Field label="Style number *">
          <Input value={state.styleNumber} onChange={(v) => update("styleNumber", v)} required />
        </Field>
        <Field label="Business area *">
          {businessAreas.length === 0 ? (
            <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              No business areas yet — go to <a href="/business-areas" className="underline">Business areas</a>{" "}
              or run a Styles sync.
            </div>
          ) : (
            <select
              value={state.businessAreaId}
              onChange={(e) => pickBusinessArea(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              required
            >
              {businessAreas.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} {b.mondayValue !== b.name && `(${b.mondayValue})`}
                </option>
              ))}
            </select>
          )}
          <ProdSpecPreview
            customerId={state.customerId}
            businessAreaId={state.businessAreaId}
            matched={matchedProdSpec}
          />
        </Field>
        <Field label="Supplier" hint="Optional. Sets Style.supplierId for the SharePoint upload path.">
          <select
            value={state.supplierId}
            onChange={(e) => update("supplierId", e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.country ? ` · ${s.country}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Country of origin"
          hint="Shown as 'Made in …' on care labels. Defaults to the linked supplier's country when blank; a Monday sync / webhook overwrites a hand-typed value."
        >
          <Input value={state.countryOfOrigin} onChange={(v) => update("countryOfOrigin", v)} />
        </Field>
      </Section>

      <Section title="Product translations">
        <Field
          label="Composition (multilingual)"
          hint='Format: "EN: 100% Cotton | DE: 100% Baumwolle | FR: 100% Coton"'
          wide
        >
          <Textarea value={state.composition} onChange={(v) => update("composition", v)} rows={2} />
        </Field>
        <Field
          label="Product name (multilingual)"
          hint='Format: "EN: T-Shirt | DE: T-Shirt | FR: T-shirt"'
          wide
        >
          <Textarea
            value={state.productNameTranslations}
            onChange={(v) => update("productNameTranslations", v)}
            rows={2}
          />
        </Field>
      </Section>

      <Section title="Wash care" wide>
        {washSymbols.length === 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No wash-care symbols yet — go to <a href="/settings/washcare-symbols" className="underline">Settings → Wash-care symbols</a>{" "}
            and seed or upload some first.
          </div>
        ) : (
          <WashSymbolPicker
            symbols={washSymbols}
            selected={state.washSymbolCodes}
            onToggle={toggleWashSymbol}
          />
        )}
      </Section>

      <Section title="Sizes & barcodes">
        <Field label="Size labels" hint='Comma-separated, e.g. "XS,S,M,L,XL"' wide>
          <Input value={state.sizes} onChange={(v) => update("sizes", v)} />
        </Field>
        <Field
          label="EAN per size"
          hint='Format: "XS=4710000000001,S=4710000000018,M=4710000000025"'
          wide
        >
          <Textarea value={state.ean13} onChange={(v) => update("ean13", v)} rows={2} />
        </Field>
      </Section>

      <Section title="Carton">
        <Field label="KL number"><Input value={state.klNumber} onChange={(v) => update("klNumber", v)} /></Field>
        <Field label="Supplier number"><Input value={state.supplierNumber} onChange={(v) => update("supplierNumber", v)} /></Field>
        <Field label="Lot"><Input value={state.lot} onChange={(v) => update("lot", v)} /></Field>
        <Field label="Outer VE (carton qty)"><Input value={state.cartonQty} onChange={(v) => update("cartonQty", v)} /></Field>
        <Field label="Carton EAN-13" hint="Single 13-digit barcode for the outer box">
          <Input value={state.cartonEan} onChange={(v) => update("cartonEan", v)} />
        </Field>
      </Section>

      <Section title="Colour">
        <Field label="Colour name"><Input value={state.colourName} onChange={(v) => update("colourName", v)} /></Field>
        <Field label="Colour code"><Input value={state.colourCode} onChange={(v) => update("colourCode", v)} /></Field>
      </Section>

      <Section title="Pricing & contact">
        <Field label="Price" hint='Used by Loved sticker variant. Format: "19.99 EUR"'>
          <Input value={state.price} onChange={(v) => update("price", v)} />
        </Field>
        <Field label="Supplier email">
          <Input
            type="email"
            value={state.supplierEmail}
            onChange={(v) => update("supplierEmail", v)}
          />
        </Field>
      </Section>

      <Section title="QR code">
        <Field
          label="Linked QR image"
          hint="Optional. Printed as-is on Care Label 02 (page 4). Upload images at Settings → QR codes."
        >
          {qrImages.length === 0 ? (
            <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              No QR images yet — add one at{" "}
              <a href="/settings/qr-codes" className="underline">Settings → QR codes</a>.
            </div>
          ) : (
            <select
              value={state.qrImageId}
              onChange={(e) => update("qrImageId", e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">— none —</option>
              {qrImages.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <QrPreview qrImages={qrImages} selectedId={state.qrImageId} />
      </Section>

      {error && <p className="mt-4 text-xs text-red-600">{error}</p>}

      <div className="mt-6 flex gap-3">
        <button
          type="submit"
          disabled={pending || !state.customerId}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Rendering PDFs…" : mode === "create" ? "Save & render PDFs" : "Save & re-render PDFs"}
        </button>
        <span className="self-center text-xs text-zinc-500">
          Rendering takes ~5–10 s the first time (Puppeteer warm-up).
        </span>
      </div>
    </form>
  );
}

// Re-export the form state shape for the edit page to build its `initial` prop.
export type ManualFormState = FormState;

function WashSymbolPicker({
  symbols,
  selected,
  onToggle,
}: {
  symbols: WashSymbol[];
  selected: string[];
  onToggle: (code: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
      {symbols.map((s) => {
        const isSelected = selected.includes(s.code);
        // The `svg` column holds EITHER raw SVG markup ("<svg …>…</svg>")
        // OR a data URL ("data:image/png;base64,…" / svg+xml encoded).
        // PNG / JPG uploads via /settings/washcare-symbols land as
        // data URLs — pass them through without re-wrapping. Raw SVG
        // markup gets base64-encoded for the same data-url shape so
        // the <img> tag works either way. Encoded identically on
        // server + client (btoa is global in Node 16+) to avoid the
        // hydration mismatch React 19 flags.
        const dataUrl = !s.svg
          ? null
          : s.svg.startsWith("data:")
            ? s.svg
            : `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s.svg)))}`;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onToggle(s.code)}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${
              isSelected
                ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                : "border-zinc-200 bg-white hover:border-zinc-400"
            }`}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-zinc-50">
              {dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt={s.code} className="h-6 w-6 object-contain" />
              ) : (
                <span className="text-[8px] text-zinc-400">no svg</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{s.name}</div>
              <div className="truncate font-mono text-[10px] text-zinc-500">{s.code}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Small preview of the QR image currently selected in the picker. The
// `image` column holds EITHER raw SVG markup OR a data URL (PNG/JPG/SVG
// base64) — mirror the WashSymbolPicker encoding so both render via a
// plain <img>, and keep server/client base64 identical to dodge the
// React 19 hydration mismatch.
function QrPreview({ qrImages, selectedId }: { qrImages: QrImage[]; selectedId: string }) {
  const selected = qrImages.find((q) => q.id === selectedId);
  if (!selected) return null;
  const img = selected.image;
  const dataUrl = !img
    ? null
    : img.startsWith("data:")
      ? img
      : `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(img)))}`;
  return (
    <div className="mt-3 flex items-center gap-3">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt={selected.name} className="h-16 w-16 object-contain" />
        ) : (
          <span className="text-[10px] text-zinc-400">no image</span>
        )}
      </div>
      <div className="text-xs text-zinc-500">
        <div className="font-medium text-zinc-700">{selected.name}</div>
        Prints on Care Label 02, page 4.
      </div>
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
    <section className="mt-6 rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h2>
      <div className={wide ? "" : "grid grid-cols-2 gap-4"}>{children}</div>
    </section>
  );
}

// Inline preview chip rendered under the Business-area select. Tells the
// operator at fill-time exactly which ProdSpec the (customer × BA) pair
// will resolve to, *and* whether that ProdSpec has Outputs configured —
// the silent footgun that produces NO_OUTPUTS at render time.
function ProdSpecPreview({
  customerId,
  businessAreaId,
  matched,
}: {
  customerId: string;
  businessAreaId: string;
  matched: { id: string; name: string; outputsCount: number } | null;
}) {
  if (!customerId || !businessAreaId) {
    return (
      <p className="mt-2 text-[11px] text-zinc-500">
        Pick a Business area to see which ProdSpec this Style will use.
      </p>
    );
  }
  if (!matched) {
    return (
      <p className="mt-2 text-[11px] text-amber-800">
        ⚠ No ProdSpec exists for this Customer × Business Area yet — it&apos;ll be auto-created on save
        with empty Outputs. You&apos;ll need to open it and add variants before any PDFs render.
      </p>
    );
  }
  if (matched.outputsCount === 0) {
    return (
      <p className="mt-2 text-[11px] text-amber-800">
        ⚠ Linked ProdSpec: <strong>{matched.name}</strong> — has no Outputs configured.{" "}
        <a href={`/prod-specs/${matched.id}`} target="_blank" rel="noreferrer" className="underline">
          Open and add variants ↗
        </a>
      </p>
    );
  }
  return (
    <p className="mt-2 text-[11px] text-emerald-700">
      ✓ Linked ProdSpec: <strong>{matched.name}</strong> — {matched.outputsCount} output
      {matched.outputsCount === 1 ? "" : "s"} configured.{" "}
      <a href={`/prod-specs/${matched.id}`} target="_blank" rel="noreferrer" className="underline">
        Open ↗
      </a>
    </p>
  );
}

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`text-xs font-medium text-zinc-700 ${wide ? "col-span-2" : ""}`}>
      {label}
      {children}
      {hint && <span className="mt-1 block font-normal text-zinc-500">{hint}</span>}
    </label>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
    />
  );
}

function Textarea({
  value,
  onChange,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-zinc-900"
    />
  );
}
