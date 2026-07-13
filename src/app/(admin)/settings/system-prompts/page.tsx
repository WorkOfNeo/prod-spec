import Link from "next/link";
import { requireAdminPage } from "@/lib/auth-server";
import { listSystemPrompts } from "@/lib/prompts/system-prompts";
import { PromptsEditor, type PromptView } from "./prompts-editor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Prompts" };

const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// Settings → Prompts. Admins edit the system prompts that steer the app's AI
// features (starting with the rejection log's AI auto-fix). A saved prompt
// overrides the built-in default; "Reset to default" removes the override.
export default async function SystemPromptsPage() {
  await requireAdminPage();

  const prompts = await listSystemPrompts();
  // Availability is table-wide (all rows share the system_prompts table).
  const available = prompts.every((p) => p.available);

  const views: PromptView[] = prompts.map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
    content: p.content,
    source: p.source,
    updatedByEmail: p.updatedByEmail,
    updatedAtLabel: p.updatedAt ? STAMP.format(p.updatedAt) : null,
  }));

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Prompts</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          System prompts that steer the app&apos;s AI features. Editing one takes effect immediately on
          the next AI run. The strict output format each feature needs is fixed in code and appended
          automatically — you&apos;re editing the guidance, not the machine contract. Reset to default
          any time.
        </p>
      </div>

      {!available ? (
        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The <code className="font-mono">system_prompts</code> table isn&apos;t deployed yet — the
          built-in defaults below are live and in use, but saving is disabled until{" "}
          <code className="font-mono">db:deploy</code> runs.
        </div>
      ) : null}

      <PromptsEditor prompts={views} canSave={available} />
    </div>
  );
}
