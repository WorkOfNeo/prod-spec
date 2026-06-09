"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CustomerConfig } from "@/lib/customers/config";

export function CustomerConfigForm({
  customerId,
  initial,
}: {
  customerId: string;
  initial: CustomerConfig;
}) {
  const router = useRouter();
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? "");
  const [barcodeFontFamily, setBarcodeFontFamily] = useState(initial.barcodeFont?.family ?? "");
  const [barcodeFontSrc, setBarcodeFontSrc] = useState(initial.barcodeFont?.src ?? "");
  const [columnMappingText, setColumnMappingText] = useState(
    JSON.stringify(initial.columnMapping, null, 2),
  );
  const [requiredFieldsText, setRequiredFieldsText] = useState(
    JSON.stringify(initial.requiredFields, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      let columnMapping: unknown;
      let requiredFields: unknown;
      try {
        columnMapping = JSON.parse(columnMappingText);
      } catch (err) {
        setError(`columnMapping JSON: ${(err as Error).message}`);
        return;
      }
      try {
        requiredFields = JSON.parse(requiredFieldsText);
      } catch (err) {
        setError(`requiredFields JSON: ${(err as Error).message}`);
        return;
      }

      const config: Record<string, unknown> = {
        ...initial,
        columnMapping,
        requiredFields,
        logoUrl: logoUrl || undefined,
      };
      if (barcodeFontFamily && barcodeFontSrc) {
        config.barcodeFont = { family: barcodeFontFamily, src: barcodeFontSrc };
      } else {
        delete config.barcodeFont;
      }

      const res = await fetch(`/api/admin/customers/${customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ? `${body.error}` : `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Logo URL" hint="Used by the Hangtag template's branded header.">
          <input
            type="text"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
            placeholder="https://example.com/logo.png"
          />
        </Field>
        <Field label="Barcode font family">
          <input
            type="text"
            value={barcodeFontFamily}
            onChange={(e) => setBarcodeFontFamily(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
            placeholder="Libre Barcode 128 Text"
          />
        </Field>
        <Field
          label="Barcode font source URL"
          hint="Full https URL (Google Fonts, CDN) or a /public-relative path."
          wide
        >
          <input
            type="text"
            value={barcodeFontSrc}
            onChange={(e) => setBarcodeFontSrc(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
            placeholder="https://fonts.googleapis.com/css2?family=Libre+Barcode+128+Text"
          />
        </Field>
      </div>

      <Field label="Column mapping (Monday column ids → ProdSpec fields)" wide>
        <textarea
          value={columnMappingText}
          onChange={(e) => setColumnMappingText(e.target.value)}
          rows={10}
          spellCheck={false}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
        />
      </Field>

      <Field
        label="Required fields"
        hint='Array of { id: "monday_column_id", label: "Composition" }.'
        wide
      >
        <textarea
          value={requiredFieldsText}
          onChange={(e) => setRequiredFieldsText(e.target.value)}
          rows={6}
          spellCheck={false}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
        />
      </Field>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save config"}
        </button>
      </div>
    </form>
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
