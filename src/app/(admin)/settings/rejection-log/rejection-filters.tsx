"use client";

// Dynamic dimension filters for the rejection log. Single-select dropdowns
// whose options are derived from the tickets present (passed in by the list),
// so they stay in sync with the backlog. "" = All. Sits in the filter bar
// next to the search box + status pills; selections AND together.

export function FilterSelect({
  label,
  value,
  options,
  onChange,
  formatOption,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  // Optional display formatter (e.g. CARTON_MARKING → "Carton marking").
  formatOption?: (option: string) => string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={`Filter by ${label.toLowerCase()}`}
        className={`max-w-[12rem] rounded-md border px-2 py-1 text-xs focus:ring-2 focus:ring-zinc-900 focus:outline-none ${
          value
            ? "border-zinc-900 bg-zinc-900 font-semibold text-white"
            : "border-zinc-300 bg-white text-zinc-700"
        }`}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {formatOption ? formatOption(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}

// "CARTON_MARKING" → "Carton marking" for the Output-type dropdown.
export function outputTypeLabel(docType: string): string {
  return docType
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
