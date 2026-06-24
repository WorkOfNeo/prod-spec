// Pure, dependency-free helpers for the `layout:<id>` variantKey scheme that
// Output Builder layouts emit. Kept apart from variants.ts (which imports the
// Prisma client and the render pipeline) so these string ops can be used from
// client components, tests, and lightweight server code without dragging in
// the database.

export const LAYOUT_VARIANT_PREFIX = "layout:";

export function layoutVariantKey(layoutId: string): string {
  return `${LAYOUT_VARIANT_PREFIX}${layoutId}`;
}

export function isLayoutVariantKey(key: string): boolean {
  return key.startsWith(LAYOUT_VARIANT_PREFIX);
}

// The OutputLayout id behind a layout variant key, or null for non-layout
// keys. Strips the `#<suffix>` that multi-document (per-EAN split) assets
// carry, so `layout:abc#m-blue` and `layout:abc` both resolve to `abc`.
export function layoutIdFromVariantKey(key: string | null | undefined): string | null {
  if (!key || !key.startsWith(LAYOUT_VARIANT_PREFIX)) return null;
  return key.slice(LAYOUT_VARIANT_PREFIX.length).split("#")[0] || null;
}
