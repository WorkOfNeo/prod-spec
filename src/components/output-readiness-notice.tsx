import Link from "next/link";
import type {
  ReadinessNotice,
  ReadinessRole,
  ReadinessStep,
  ReadinessTone,
  ReadinessAction,
  ReadinessActionKey,
  StepStatus,
} from "@/lib/styles/readiness-notice";

// =====================================================
// The shared Output Readiness Notice component. Dumb by design — ALL logic
// lives in the selector (styleReadinessNotice). This renders:
//   • <ReadinessPill> — the headline pill for the /styles list.
//   • <OutputReadinessNotice> — the full panel/ladder for the review page,
//     review cards, and the style detail page.
//
// Pure render, no state → drops straight into server components. `hrefs` is an
// optional map from action key → URL; when absent, actions render as plain
// (non-link) labels. Tones / classes mirror the approved design (emerald /
// amber / red / sky / zinc).
// =====================================================

// Pill tone → Tailwind classes (matches EAN_STATUS_META palette in the app).
const PILL_TONE: Record<ReadinessTone, string> = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-700",
  sky: "border-sky-200 bg-sky-50 text-sky-800",
  zinc: "border-zinc-200 bg-zinc-100 text-zinc-600",
};

const DOT_TONE: Record<ReadinessTone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  sky: "bg-sky-500",
  zinc: "bg-zinc-400",
};

// Progress-bar fill tone.
const BAR_TONE: Record<ReadinessTone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  sky: "bg-sky-500",
  zinc: "bg-zinc-400",
};

// Step number badge by status (the small numbered circle in the ladder).
const NUM_STATUS: Record<StepStatus, string> = {
  ok: "bg-emerald-100 text-emerald-800",
  waiting: "bg-amber-100 text-amber-800",
  blocked: "bg-red-100 text-red-800",
  running: "bg-sky-100 text-sky-800",
  idle: "bg-zinc-200 text-zinc-500",
};

// The glyph inside the step badge.
function stepGlyph(step: ReadinessStep): string {
  switch (step.status) {
    case "ok":
      return "✓";
    case "idle":
      return "–";
    default:
      return "!";
  }
}

export type ReadinessHrefs = Partial<Record<ReadinessActionKey, string>>;

// The headline pill — used standalone on the /styles list.
export function ReadinessPill({
  notice,
  className = "",
}: {
  notice: Pick<ReadinessNotice, "headline" | "tone">;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PILL_TONE[notice.tone]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[notice.tone]}`} aria-hidden="true" />
      {notice.headline}
    </span>
  );
}

function StepAction({ action, hrefs }: { action: ReadinessAction; hrefs?: ReadinessHrefs }) {
  const base =
    action.kind === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-800 border border-zinc-900"
      : action.kind === "link"
        ? "text-sky-700 hover:underline"
        : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50";
  const padded = action.kind === "link" ? "" : "px-2.5 py-1";
  const cls = `inline-flex items-center gap-1 rounded-md text-[11px] font-medium ${padded} ${base}`;

  const href = action.key ? hrefs?.[action.key] : undefined;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {action.label}
      </Link>
    );
  }
  // No href supplied → render as a non-link label (still styled, but inert).
  return <span className={cls}>{action.label}</span>;
}

function FieldChips({ fields }: { fields: { field: string; label: string }[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {fields.map((f) => (
        <span
          key={f.field}
          className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
        >
          {f.label}
        </span>
      ))}
    </div>
  );
}

function Step({
  step,
  index,
  hrefs,
}: {
  step: ReadinessStep;
  index: number;
  hrefs?: ReadinessHrefs;
}) {
  // The badge shows a glyph for ok/idle, otherwise a count when the title
  // starts with a number (e.g. "2 outputs…"), else "!".
  const leadingNum = step.title.match(/^(\d+)/)?.[1];
  const badge =
    step.status === "ok" || step.status === "idle"
      ? stepGlyph(step)
      : (leadingNum ?? stepGlyph(step));

  return (
    <li className="flex gap-3 border-b border-zinc-100 px-4 py-3 last:border-b-0">
      <span
        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${NUM_STATUS[step.status]}`}
        aria-hidden="true"
      >
        {badge}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-zinc-800">{step.title}</div>
        <div className="mt-0.5 text-[12px] text-zinc-500">{step.detail}</div>

        {/* Per-output field breakdown (field-waiting step). */}
        {step.outputs && step.outputs.length > 0 ? (
          <div className="mt-2 space-y-2">
            {step.outputs.map((o) => (
              <div key={o.name}>
                <div className="text-[12px] font-medium text-zinc-700">{o.name}</div>
                {o.note ? <div className="text-[12px] text-amber-700">{o.note}</div> : null}
                <FieldChips fields={o.fields} />
              </div>
            ))}
          </div>
        ) : step.fields && step.fields.length > 0 ? (
          <FieldChips fields={step.fields} />
        ) : null}

        {step.actions && step.actions.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {step.actions.map((a, i) => (
              <StepAction key={`${step.key}-act-${i}`} action={a} hrefs={hrefs} />
            ))}
          </div>
        ) : null}
      </div>
      <span className="sr-only">step {index + 1}</span>
    </li>
  );
}

// The full notice panel — header pill + progress bar, then the step ladder.
export function OutputReadinessNotice({
  notice,
  role,
  hrefs,
  title,
  subtitle,
  className = "",
}: {
  notice: ReadinessNotice;
  role: ReadinessRole;
  hrefs?: ReadinessHrefs;
  // Optional header line (e.g. "2210 Bridger · C-PO61840"). Surfaces supply it.
  title?: string;
  subtitle?: string;
  className?: string;
}) {
  const pct = notice.total > 0 ? Math.round((notice.ready / notice.total) * 100) : 0;

  // Reviewer banner: don't approve while anything is blocked or waiting.
  const hasBlocked = notice.steps.some((s) => s.tone === "red");
  const hasWaiting = notice.steps.some((s) => s.key === "awaiting-fields");
  const showReviewerBanner = role === "REVIEWER" && (hasBlocked || hasWaiting);

  return (
    <div className={`overflow-hidden rounded-xl border border-zinc-200 bg-white ${className}`}>
      <div className="border-b border-zinc-100 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <div className="text-[15px] font-bold text-zinc-900">{title}</div>
            ) : null}
            {subtitle ? <div className="text-xs text-zinc-500">{subtitle}</div> : null}
            {notice.total > 0 ? (
              <div className="mt-0.5 text-xs text-zinc-500 tabular-nums">
                {notice.ready} of {notice.total} ready
              </div>
            ) : null}
          </div>
          <ReadinessPill notice={notice} />
        </div>
        {notice.total > 0 ? (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <span
              className={`block h-full rounded-full ${BAR_TONE[notice.tone]}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </div>

      {showReviewerBanner ? (
        <div className="border-b border-amber-100 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
          <strong>Don&apos;t approve as final yet.</strong>{" "}
          {hasWaiting
            ? "Some outputs can't generate because required fields are blank on Monday. Add them on Monday and they generate automatically — then they appear here for review. "
            : ""}
          Nothing is sent to the supplier until every output is decided.
        </div>
      ) : null}

      <ul className="m-0 list-none p-0">
        {notice.steps.map((step, i) => (
          <Step key={step.key} step={step} index={i} hrefs={hrefs} />
        ))}
      </ul>
    </div>
  );
}
