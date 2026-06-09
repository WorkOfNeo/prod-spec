"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";

type CountryRow = {
  id: string;
  code: string;
  nameEn: string;
  languageCode: string;
  nameTranslations: Record<string, string>;
  active: boolean;
  mondayValue: string | null;
};

// Language descriptor — `code` is the JSON key in nameTranslations,
// `name` is what we show as the label next to each input.
type LanguageInfo = { code: string; name: string };

type Props = {
  initialCountries: CountryRow[];
  availableLanguages: LanguageInfo[];
};

export function CountryList({ initialCountries, availableLanguages }: Props) {
  const [dialog, setDialog] = useState<
    | { mode: "create" }
    | { mode: "edit"; row: CountryRow }
    | null
  >(null);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <SeedButton />
        <button
          type="button"
          onClick={() => setDialog({ mode: "create" })}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          + New country
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Name (EN)</th>
              <th className="px-4 py-2">Language</th>
              <th className="px-4 py-2">Translations</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {initialCountries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                  No countries yet. Click <strong>Seed standard set</strong> for a starter pack of
                  16 common countries with pre-filled translations.
                </td>
              </tr>
            ) : (
              initialCountries.map((c) => (
                <tr key={c.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-mono text-xs">{c.code}</td>
                  <td className="px-4 py-2 font-medium">{c.nameEn}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-600">{c.languageCode}</td>
                  <td className="px-4 py-2 text-xs text-zinc-600">
                    {Object.keys(c.nameTranslations).length}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        c.active ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {c.active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setDialog({ mode: "edit", row: c })}
                      className="text-xs text-zinc-700 underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {dialog && (
        <CountryDialog
          mode={dialog.mode}
          row={dialog.mode === "edit" ? dialog.row : null}
          availableLanguages={availableLanguages}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function SeedButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function seed() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/countries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedStandard: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsg(`error: ${body.error ?? res.statusText}`);
        return;
      }
      setMsg(`created ${body.created}, skipped ${body.skipped}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={seed}
        disabled={busy}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Seeding…" : "Seed standard set"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </div>
  );
}

function CountryDialog({
  mode,
  row,
  availableLanguages,
  onClose,
}: {
  mode: "create" | "edit";
  row: CountryRow | null;
  availableLanguages: LanguageInfo[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState(row?.code ?? "");
  const [nameEn, setNameEn] = useState(row?.nameEn ?? "");
  const [languageCode, setLanguageCode] = useState(row?.languageCode ?? "");
  const [active, setActive] = useState(row?.active ?? true);
  const [mondayValue, setMondayValue] = useState(row?.mondayValue ?? "");
  const [translations, setTranslations] = useState<Record<string, string>>(
    row?.nameTranslations ?? {},
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Show one input per active Language. Orphan codes already on the row
  // get appended at the end so the operator can edit / clear them. The
  // primary languageCode is included so it shows up even when no DB row
  // backs it yet.
  const languageInputs: LanguageInfo[] = (() => {
    const seen = new Set<string>();
    const out: LanguageInfo[] = [];
    for (const lang of availableLanguages) {
      if (seen.has(lang.code)) continue;
      seen.add(lang.code);
      out.push(lang);
    }
    const extras = new Set([...Object.keys(translations), languageCode].filter(Boolean));
    for (const code of extras) {
      if (seen.has(code)) continue;
      seen.add(code);
      out.push({ code, name: code });
    }
    return out;
  })();

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const url =
        mode === "create" ? "/api/admin/countries" : `/api/admin/countries/${row?.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const filtered = Object.fromEntries(
        Object.entries(translations).filter(([, v]) => v.trim().length > 0),
      );
      const payload: Record<string, unknown> = {
        nameEn,
        languageCode: languageCode.toLowerCase(),
        nameTranslations: filtered,
        mondayValue: mondayValue.trim() ? mondayValue : null,
      };
      if (mode === "create") payload.code = code.toUpperCase();
      else payload.active = active;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!row) return;
    if (!confirm(`Delete country "${row.nameEn}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/countries/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-6">
      <div className="my-12 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {mode === "create" ? "New country" : `Edit ${row?.nameEn}`}
          </h2>
          <button onClick={onClose} className="text-xs text-zinc-500 underline">
            Close
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs font-medium text-zinc-700">
            Code
            <input
              type="text"
              value={code}
              disabled={mode === "edit"}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={8}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm uppercase disabled:bg-zinc-50"
              placeholder="DK"
              required
            />
          </label>
          <label className="col-span-2 text-xs font-medium text-zinc-700">
            Name (EN)
            <input
              type="text"
              value={nameEn}
              onChange={(e) => setNameEn(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="Denmark"
              required
            />
          </label>
          <label className="text-xs font-medium text-zinc-700">
            Language code
            <input
              type="text"
              value={languageCode}
              onChange={(e) => setLanguageCode(e.target.value.toLowerCase())}
              maxLength={8}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm lowercase"
              placeholder="da"
              required
            />
          </label>
          <label className="col-span-2 text-xs font-medium text-zinc-700">
            Monday value <span className="font-normal text-zinc-400">(optional)</span>
            <input
              type="text"
              value={mondayValue}
              onChange={(e) => setMondayValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="China"
            />
          </label>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-700">Name translations</span>
            <span className="text-[10px] text-zinc-500">
              How this country's name appears on a label in each language
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {languageInputs.map((lang) => (
              <label key={lang.code} className="text-xs font-medium text-zinc-700">
                {lang.name}{" "}
                <span className="font-mono text-[10px] font-normal text-zinc-400">{lang.code}</span>
                <input
                  type="text"
                  value={translations[lang.code] ?? ""}
                  onChange={(e) =>
                    setTranslations((prev) => ({ ...prev, [lang.code]: e.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
                />
              </label>
            ))}
          </div>
          <AddLangInput
            onAdd={(lang) =>
              setTranslations((prev) => (prev[lang] !== undefined ? prev : { ...prev, [lang]: "" }))
            }
          />
        </div>

        {mode === "edit" && (
          <div className="mt-5">
            <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
          </div>
        )}

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          {mode === "edit" ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="text-xs text-red-600 underline disabled:opacity-50"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !code || !nameEn || !languageCode}
              className="rounded-md bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddLangInput({ onAdd }: { onAdd: (lang: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const lang = value.trim().toLowerCase();
        if (!lang || lang.length < 2) return;
        onAdd(lang);
        setValue("");
      }}
      className="mt-2 inline-flex items-center gap-2 text-xs"
    >
      <input
        type="text"
        placeholder="add lang code"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={8}
        className="w-28 rounded-md border border-zinc-300 px-2 py-1 font-mono text-xs lowercase"
      />
      <button
        type="submit"
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
      >
        + Add
      </button>
    </form>
  );
}
