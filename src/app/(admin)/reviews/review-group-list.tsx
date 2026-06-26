import { StyleTaskList } from "@/components/style-task-list";
import type { ReviewGroup } from "@/lib/dashboard/review-tasks";

// The "Review" tab body: the untouched queue collapsed into one expandable group
// per prod spec (== customer × business area, e.g. Netto · Private Label).
// Opening a group reveals its styles via the shared StyleTaskList — each style's
// current outputs plus its "Start review" action.
//
// NOTE on the chevron: this group's <details> uses a NAMED Tailwind group
// (group/revgroup) so its rotate-on-open targets only itself. StyleTaskList's
// own per-style <details> uses the bare `group`, and nesting a bare group inside
// a bare group would make every inner chevron rotate as soon as the outer group
// opened. Naming this one keeps the two independent.
export function ReviewGroupList({ groups }: { groups: ReviewGroup[] }) {
  return (
    <div className="mt-3 space-y-3">
      {groups.map((g) => {
        const title = g.prodSpecName ?? g.customerName;
        // Subtitle: customer · business area. Prod-spec names in this DB are
        // already "Customer · BA", so only show it when it actually adds
        // something beyond the title (e.g. a custom prod-spec name).
        const subtitleRaw = [g.prodSpecName ? g.customerName : null, g.businessArea]
          .filter((s): s is string => !!s)
          .join(" · ");
        const subtitle = subtitleRaw && subtitleRaw !== title ? subtitleRaw : null;
        return (
          <details key={g.key} className="group/revgroup rounded-lg border border-zinc-200 bg-white">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open/revgroup:rotate-90"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-zinc-900">{title}</div>
                {subtitle ? <div className="truncate text-xs text-zinc-500">{subtitle}</div> : null}
              </div>
              <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-600">
                {g.tasks.length} awaiting
              </span>
            </summary>
            <div className="border-t border-zinc-100 px-3 pb-3">
              <StyleTaskList tasks={g.tasks} activityPrefix="ready " />
            </div>
          </details>
        );
      })}
    </div>
  );
}
