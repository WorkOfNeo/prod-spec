import type { StyleData } from "./types";

export type OutputLang = { code: string; label: string };

// Resolve the languages a template should render for this style.
//
// When the style carries an explicit selection (ProdSpec.outputLanguages,
// toggled per prod spec), map those codes in order and derive a short
// uppercase label from each code. Otherwise return the template's built-in
// `fallback` set unchanged, so prod specs that haven't chosen languages
// render exactly as they did before this feature.
export function resolveOutputLangs(
  style: Pick<StyleData, "outputLanguages">,
  fallback: ReadonlyArray<OutputLang>,
): OutputLang[] {
  const selected = style.outputLanguages ?? [];
  if (selected.length === 0) return [...fallback];
  return selected.map((code) => ({ code, label: code.toUpperCase() }));
}

// Code-only variant for templates / blocks that only need the list of codes
// (e.g. the "Made in <country>" run, the info-area composition list).
export function resolveOutputLangCodes(
  style: Pick<StyleData, "outputLanguages">,
  fallback: ReadonlyArray<string>,
): string[] {
  const selected = style.outputLanguages ?? [];
  return selected.length > 0 ? selected : [...fallback];
}
