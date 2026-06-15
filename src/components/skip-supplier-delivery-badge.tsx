import { cn } from "@/lib/utils";

// Surfaces the Customer.config.skipSupplierDelivery flag wherever a style or
// customer is shown. Customers like Woolworth deliver everything themselves,
// so the app must not send supplier delivery for their styles. This badge only
// COMMUNICATES that intent — the delivery skip itself is enforced in the
// approval-chain-reaction track, which reads the same flag. Pure presentational
// (no client APIs), so it renders inside Server Components directly.
export function SkipSupplierDeliveryBadge({ className }: { className?: string }) {
  return (
    <span
      title="This customer delivers their own goods. The app will not send supplier delivery for their styles (enforced by the delivery step)."
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
