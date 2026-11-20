import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { loadDocTypes } from "@/lib/pdf/doc-types-db";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { listMemories, memoryLog } from "@/lib/change-requests/memory";
import { AgentMemoryClient, type MemoryEventView, type MemoryView, type ScopeOption } from "./agent-memory-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Agent memory" };

const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// Settings → Agent memory (design §5.9). Every note the change-request agent
// has suggested, kept or been told to forget, with who-did-what as a follow-
// along log. Only KEPT notes are ever read by the agent; this page is where a
// person reads, rewords, forgets or restores them, and writes their own (the
// knowledge the agent can't find in the data). Behind
// CHANGE_REQUESTS_ENABLED (404 when off) and ADMIN only.
export default async function AgentMemoryPage() {
  if (!changeRequestsEnabled()) notFound();
  await requireAdminPage();

  const [memories, log, customerRows, docTypes] = await Promise.all([
    listMemories(),
    memoryLog(30),
    db.customer.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    loadDocTypes(),
  ]);
  // What a new note can be scoped to. Blank customer names exist in live data.
  const customers: ScopeOption[] = customerRows.map((c) => ({ value: c.id, label: c.name.trim() || "Unnamed client" }));
  const docTypeOptions: ScopeOption[] = docTypes.map((d) => ({ value: d.value, label: d.label }));

  const views: MemoryView[] = memories.map((m) => ({
    id: m.id,
    scope: m.scope,
    scopeLabel: m.scopeLabel,
    text: m.text,
    state: m.state,
    sourceLabel: m.sourceLabel,
    sourceRequestId: m.requestNumber != null ? m.sourceRequestId : null,
    usedCount: m.usedCount,
    lastUsedLabel: m.lastUsedAt ? STAMP.format(m.lastUsedAt) : null,
    updatedLabel: STAMP.format(m.updatedAt),
  }));

  const events: MemoryEventView[] = log.map((e) => ({
    key: `${e.id}-${e.when.getTime()}`,
    kind: e.kind,
    label: e.label,
    text: e.text,
    scopeLabel: e.scopeLabel,
    source: e.source,
    whenLabel: STAMP.format(e.when),
  }));

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Agent memory</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          What the agent should know that it can&apos;t find in the data. Write a note yourself, or keep
          one the agent suggests after you correct it in a review; the agent reads kept notes on every
          run they apply to. You can edit and delete every note.
        </p>
      </div>

      <AgentMemoryClient memories={views} events={events} customers={customers} docTypes={docTypeOptions} />
    </div>
  );
}
