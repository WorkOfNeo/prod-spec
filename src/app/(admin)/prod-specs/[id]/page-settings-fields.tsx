"use client";

import type { PageSettings } from "@/lib/prod-spec/config";
import { Toggle } from "@/components/toggle";

// Per-page print tuning for a bundle framing page (cover / general
// information): margins = mm from the page edge to the content, applied
// to EVERY sheet of a multi-page document; base font scales the whole
// page (all sizes are relative to it); footer toggles the grey sign-off
// line. Values autosave with the rest of the spec; previews refresh
// after each save.
export function PageSettingsFields({
  value,
  onChange,
}: {
  value: PageSettings;
  onChange: (next: PageSettings) => void;
}) {
  function set<K extends keyof PageSettings>(key: K, v: PageSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          Margins · mm from page edge
        </div>
        <div className="mt-1.5 grid grid-cols-4 gap-2">
          <Num label="Top" value={value.marginTopMm} min={0} max={80} step={1} onChange={(n) => set("marginTopMm", n)} />
          <Num label="Right" value={value.marginRightMm} min={0} max={80} step={1} onChange={(n) => set("marginRightMm", n)} />
          <Num label="Bottom" value={value.marginBottomMm} min={0} max={80} step={1} onChange={(n) => set("marginBottomMm", n)} />
          <Num label="Left" value={value.marginLeftMm} min={0} max={80} step={1} onChange={(n) => set("marginLeftMm", n)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Num
          label="Base font · pt"
          hint="Headings & tables scale with it"
          value={value.baseFontPt}
          min={6}
          max={24}
          step={0.5}
          onChange={(n) => set("baseFontPt", n)}
        />
        <Num
          label="Line height"
          value={value.lineHeight}
          min={1}
          max={2.5}
          step={0.05}
          onChange={(n) => set("lineHeight", n)}
        />
      </div>
      <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
        <span className="text-xs font-medium text-zinc-700">Footer line</span>
        <Toggle
          checked={value.showFooter}
          onChange={(next) => set("showFooter", next)}
          label={value.showFooter ? "Shown" : "Hidden"}
          size="sm"
        />
      </div>
    </div>
  );
}

function Num({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block text-[10px] font-medium uppercase tracking-wide text-zinc-500">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums normal-case"
      />
      {hint && <span className="mt-0.5 block font-normal normal-case tracking-normal text-zinc-400">{hint}</span>}
    </label>
  );
}
