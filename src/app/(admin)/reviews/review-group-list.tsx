import { ChevronRight } from "lucide-react";
import { StyleTaskList } from "@/components/style-task-list";
import type { ReviewGroup } from "@/lib/dashboard/review-tasks";
import type { StyleCommentCounts } from "@/lib/dashboard/style-comment-counts";

// The "Review" tab body: the untouched queue collapsed into one expandable group
// per prod spec (== customer × business area, e.g. Netto · Private Label).
// Opening a group reveals its styles via the shared StyleTaskList — each style's
// current outputs plus its "Start review" action.
//
// NOTE on the chevron: this group's <details> uses a NAMED Tailwind group
// (group/revgroup) so its rotate-on-open targets only itself; StyleTaskList's
// rows use their own named group (group/task), so the two stay independent.
export function ReviewGroupList({ groups, comments }: { groups: ReviewGroup[]; comments?: StyleCommentCounts }) {
  return (
    <div className="flex flex-col gap-3">
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
          <details key={g.key} className="group/revgroup border-line bg-surface overflow-hidden rounded-xl border">
            <summary className="hover:bg-subtle flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors duration-150 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={15}
                aria-hidden="true"
                className="text-faint shrink-0 transition-transform group-open/revgroup:rotate-90"
              />
              <div className="min-w-0 flex-1">
                <div className="text-ink truncate text-[13px] font-medium">{title}</div>
                {subtitle ? <div className="text-muted truncate text-[12px]">{subtitle}</div> : null}
              </div>
              <span className="text-muted shrink-0 text-[12px] tabular-nums">
                {g.tasks.length} style{g.tasks.length === 1 ? "" : "s"} waiting
              </span>
            </summary>
            <div className="border-line border-t">
              <StyleTaskList tasks={g.tasks} activityPrefix="ready " comments={comments} bare />
            </div>
          </details>
        );
      })}
    </div>
  );
}
