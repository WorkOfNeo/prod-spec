import { cn } from "@/lib/utils";

// Surfaces the Customer.config.skipSupplierDelivery flag wherever a style or
// customer is shown. Customers like Woolworth deliver everything themselves,
// so the app must not send supplier delivery for their styles. This badge only
// COMMUNICATES that intent — the delivery skip itself is enforced in the
// approval-chain-reaction track, which reads the same flag. Pure presentational
// (no client APIs), so it renders inside Server Components AND Client Components.
//
// variant:
//   "banner" (default) — full callout for detail pages (customer + style pages)
//   "chip"             — compact pill for list rows/cells (styles, customers,
//                        prod-specs tables) where space is tight but a viewer
//                        could otherwise mistake the row for one that generates
//                        supplier deliveries.
const TITLE =
  "This customer delivers their own goods. The app will not send supplier delivery for their styles (enforced by the delivery step).";

export function SkipSupplierDeliveryBadge({
  className,
  variant = "banner",
}: {
  className?: string;
  variant?: "banner" | "chip";
}) {
  if (variant === "chip") {
    return (
      <span
        title={TITLE}
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700",
          className,
        )}
      >
        <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-500" />
        Delivers own
      </span>
    );
  }
  return (
    <span
      title={TITLE}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-900",
        className,
      )}
    >
      <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-indigo-500" />
      Customer delivers own — no supplier delivery sent.
    </span>
  );
}
