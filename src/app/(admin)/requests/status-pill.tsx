import type { OutputStatus, RequestStatus } from "@/lib/change-requests/types";

// Status pills for change requests and their outputs — one colour per "who has
// to act": blue the agent, amber an admin, violet the requester, orange the
// developer; green shipped, zinc settled or not started. Plain markup (no
// hooks), so server and client components can both render it.

const TONE = {
  zinc: "bg-zinc-100 text-zinc-600 ring-zinc-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  orange: "bg-orange-50 text-orange-700 ring-orange-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  red: "bg-red-50 text-red-700 ring-red-200",
} as const;
type Tone = keyof typeof TONE;

export const REQUEST_STATUS_META: Record<RequestStatus, { label: string; tone: Tone }> = {
  NEW: { label: "New", tone: "zinc" },
  WORKING: { label: "Working", tone: "blue" },
  IN_REVIEW: { label: "In review", tone: "amber" },
  NEEDS_INFO: { label: "Needs info", tone: "violet" },
  NEEDS_CODE: { label: "Needs code", tone: "orange" },
  DONE: { label: "Done", tone: "green" },
  REJECTED: { label: "Rejected", tone: "zinc" },
};

export const OUTPUT_STATUS_META: Record<OutputStatus, { label: string; tone: Tone }> = {
  NEW: { label: "New", tone: "zinc" },
  WORKING: { label: "Working", tone: "blue" },
  IN_REVIEW: { label: "In review", tone: "amber" },
  NEEDS_INFO: { label: "Needs info", tone: "violet" },
  NEEDS_CODE: { label: "Needs code", tone: "orange" },
  APPROVED: { label: "Approved", tone: "green" },
  PUBLISHED: { label: "Live", tone: "green" },
  REJECTED: { label: "Rejected", tone: "zinc" },
  FAILED: { label: "Failed", tone: "red" },
};

export function StatusPill({ label, tone, className = "" }: { label: string; tone: Tone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE[tone]}  ${className}`}
    >
      {label}
    </span>
  );
}

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const meta = REQUEST_STATUS_META[status] ?? { label: status, tone: "zinc" as const };
  return <StatusPill label={meta.label} tone={meta.tone} />;
}

// An output's name with its status, as one pill: "Polybag sticker · In review".
export function OutputStatusPill({ label, status }: { label: string; status: OutputStatus }) {
  const meta = OUTPUT_STATUS_META[status] ?? { label: status, tone: "zinc" as const };
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ${TONE[meta.tone]}`}
      title={`${label} — ${meta.label}`}
    >
      <span className="truncate font-medium">{label}</span>
      <span className="opacity-70">· {meta.label}</span>
    </span>
  );
}
