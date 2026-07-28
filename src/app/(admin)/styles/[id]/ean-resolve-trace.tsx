import type { EanResolveTrace } from "@/lib/po/ean-trace";

// Persisted view of the LAST EAN resolve. Unlike the live Diagnostics block
// (which only exists in the response of a resolve you just triggered), this
// survives a reload — so "which source won, and what did Monday actually
// contain" is answerable at any time, including days later when someone asks
// why a barcode looks wrong.

const SOURCE_LABEL: Record<string, { text: string; cls: string }> = {
  po: { text: "PO", cls: "bg-emerald-100 text-emerald-800" },
  monday: { text: "Monday", cls: "bg-teal-100 text-teal-800" },
  none: { text: "—", cls: "bg-amber-100 text-amber-800" },
};

export function EanResolveTracePanel({ trace }: { trace: EanResolveTrace }) {
  const when = new Date(trace.at);
  const poOk = (trace.po?.eansFound ?? 0) > 0;
  const mondayWon = trace.monday.mode === "fallback";

  return (
    <details className="mt-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600">
      <summary className="cursor-pointer select-none font-medium text-zinc-700">
        Last resolve — {when.toLocaleString()}{" "}
        <span className="font-normal text-zinc-400">
          ({mondayWon ? "barcodes from Monday" : poOk ? "barcodes from the PO" : "nothing resolved"}
          {trace.forced ? ", forced" : ""})
        </span>
      </summary>

      <ol className="mt-2 space-y-2">
        {/* Step 1 — the PO scrape. Always tried first. */}
        <Step
          n={1}
          title="PO PDF scrape"
          ok={poOk}
          neutral={trace.po == null}
          detail={trace.po ? trace.po.outcome : "Skipped — this style has no PO number."}
        >
          {trace.po ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
              <Fact k="PO" v={trace.po.poNumber ?? "—"} />
              <Fact
                k="File"
                v={
                  trace.po.fileUrl ? (
                    <a href={trace.po.fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      {trace.po.fileName ?? "open"} ↗
                    </a>
                  ) : (
                    (trace.po.fileName ?? "not found")
                  )
                }
              />
              <Fact k="Matched by" v={trace.po.matchedBy} />
              {trace.po.poStyleNumbers.length > 0 ? (
                <Fact k="PO lists" v={trace.po.poStyleNumbers.join(", ")} />
              ) : null}
              <Fact k="Sections / rows" v={`${trace.po.sectionsParsed} / ${trace.po.variantsUsable}`} />
              {trace.po.colourScopeApplied ? (
                <Fact
                  k="Colour scope"
                  v={`${trace.po.colourCode ?? "—"} · ${trace.po.variantsExcludedByColour} row(s) excluded`}
                />
              ) : null}
            </dl>
          ) : null}
        </Step>

        {/* Step 2 — Monday. The bit that was previously invisible. */}
        <Step
          n={2}
          title="Monday barcode columns"
          ok={mondayWon || trace.monday.mode === "carton-overlay"}
          neutral={!trace.monday.consulted}
          detail={trace.monday.outcome}
        >
          {trace.monday.consulted ? (
            <div className="mt-1 space-y-1 text-[11px]">
              {/* The raw strings — what the buyer actually typed. */}
              <RawField label="Barcode Number" value={trace.monday.productField} />
              <RawField label="Carton Barcode number 1" value={trace.monday.cartonField} />
              {trace.monday.invalid.length > 0 ? (
                <p className="text-amber-700">
                  Ignored as invalid: {trace.monday.invalid.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}
        </Step>
      </ol>

      {/* Per-size result with source attribution. */}
      {trace.sizes.length > 0 ? (
        <table className="mt-3 w-full text-[11px]">
          <thead>
            <tr className="text-left text-zinc-400">
              <th className="pb-1 font-medium">Size</th>
              <th className="pb-1 font-medium">EAN-13</th>
              <th className="pb-1 font-medium">Carton EAN</th>
              <th className="pb-1 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {trace.sizes.map((s) => {
              const meta = SOURCE_LABEL[s.source] ?? SOURCE_LABEL.none;
              return (
                <tr key={`${s.size}-${s.ean13 ?? "x"}`}>
                  <td className="py-0.5 pr-2 text-zinc-700">{s.size}</td>
                  <td className={`py-0.5 pr-2 ${s.ean13 ? "text-zinc-700" : "text-amber-700"}`}>
                    {s.ean13 ?? "missing"}
                  </td>
                  <td className={`py-0.5 pr-2 ${s.cartonEan ? "text-zinc-700" : "text-zinc-400"}`}>
                    {s.cartonEan ?? "—"}
                  </td>
                  <td className="py-0.5">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${meta.cls}`}>{meta.text}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <p className="mt-2 text-[11px] text-zinc-500">
        Carton: {trace.carton.perSize} per-size ·{" "}
        {trace.carton.assort ? (
          <>assortment {trace.carton.assort}</>
        ) : (
          <>no assortment line (styles without an “Assort -” row on the PO have none — this is normal)</>
        )}
      </p>
    </details>
  );
}

function Step({
  n,
  title,
  ok,
  neutral,
  detail,
  children,
}: {
  n: number;
  title: string;
  ok: boolean;
  neutral: boolean;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-2">
      <span
        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          neutral ? "bg-zinc-100 text-zinc-500" : ok ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
        }`}
        aria-hidden
      >
        {neutral ? n : ok ? "✓" : "!"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-zinc-700">{title}</div>
        <p className="text-zinc-500">{detail}</p>
        {children}
      </div>
    </li>
  );
}

// An empty column is a finding, not a blank — say so explicitly rather than
// rendering nothing, which reads as "we didn't look".
function RawField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="text-zinc-400">{label}: </span>
      {value ? (
        <code className="rounded bg-zinc-100 px-1 py-0.5 text-zinc-700">{value}</code>
      ) : (
        <span className="text-zinc-400 italic">empty</span>
      )}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-400">{k}</dt>
      <dd className="text-zinc-600">{v}</dd>
    </>
  );
}
