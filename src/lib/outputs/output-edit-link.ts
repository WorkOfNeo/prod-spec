import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";

export type OutputEditLink = { href: string; label: string };

// Where to go to EDIT the thing a rejection ticket points at, derived from
// its variantKey:
//   • Output Builder layouts (`layout:<id>` / `layout:<id>#suffix`) open the
//     builder for that layout — straight to the output.
//   • The cover / general-info framing pages live in the style's Prod Spec,
//     so they deep-link to the matching editor tab.
//   • Coded templates and print-spec catalogue outputs (e.g.
//     `kaufland-private-label-carton-marking`) have no in-app editor — they
//     return null and no edit link is offered.
// prodSpecId may be null (style without an applied spec); only the framing
// pages need it, so layout links still resolve without one.
export function outputEditLink(
  variantKey: string,
  prodSpecId: string | null,
): OutputEditLink | null {
  const layoutId = layoutIdFromVariantKey(variantKey);
  if (layoutId) return { href: `/output-builder/${layoutId}`, label: "Edit output" };
  if (!prodSpecId) return null;
  if (variantKey === COVER_VARIANT_KEY) {
    return { href: `/prod-specs/${prodSpecId}?tab=cover`, label: "Edit cover page" };
  }
  if (variantKey === GENERAL_INFO_VARIANT_KEY) {
    return { href: `/prod-specs/${prodSpecId}?tab=general`, label: "Edit general info" };
  }
  return null;
}
