// Reserved synthetic variantKeys for the bundle pages' JobAsset rows.
// Double-underscore framing keeps them impossible to collide with
// catalogue keys (kebab-case) or Output Builder keys ("layout:<id>"),
// and `@@unique([jobId, variantKey])` holds since each appears once.
//
// These are pure constants split out from bundle-pages.ts (which pulls in the
// render pipeline) so they can be imported by tests and lightweight code
// without that weight. bundle-pages.ts re-exports them for existing callers.
export const COVER_VARIANT_KEY = "__cover__";
export const GENERAL_INFO_VARIANT_KEY = "__general_info__";
