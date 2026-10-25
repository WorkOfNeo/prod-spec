import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth-server";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { listMemories, memoryLog } from "@/lib/change-requests/memory";
import { AgentMemoryClient, type MemoryEventView, type MemoryView } from "./agent-memory-client";

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
// person reads, rewords, forgets or restores them. Behind
// CHANGE_REQUESTS_ENABLED (404 when off) and ADMIN only.
export default async function AgentMemoryPage() {
  if (!changeRequestsEnabled()) notFound();
  await requireAdminPage();

  const [memories, log] = await Promise.all([listMemories(), memoryLog(30)]);

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
    <div className="px-6 py-5">
      <Link href="/settings" className="text-xs text-muted underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Agent memory</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Corrections you make in a review can become notes the agent reads next time. You can read,
          edit and delete every note. The agent only suggests a note; it reads it once you keep it.
        </p>
      </div>

      <AgentMemoryClient memories={views} events={events} />
    </div>
  );
}
