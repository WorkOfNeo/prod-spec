import { db } from "@/lib/db";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { TranslationList } from "./translation-list";

export const dynamic = "force-dynamic";

export default async function TranslationsPage() {
  const [rows, languages] = await Promise.all([
    db.translation.findMany({
      orderBy: [{ active: "desc" }, { sourceText: "asc" }],
    }),
    db.language.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { code: true, name: true },
    }),
  ]);

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Translations</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          The canonical English→multilingual dictionary, synced from Monday board{" "}
          <code className="font-mono">{MONDAY_BOARDS.translations}</code>. Wash-care phrases,
          care-label text, and &ldquo;Made in&hellip;&rdquo; lines all resolve through here at render
          time — the renderer normalises an English phrase and reads the matching language string.
          Click <strong>Sync from Monday</strong> to refresh; edits live on Monday, not here.
        </p>
      </div>

      <TranslationList
        languages={languages}
        rows={rows.map((r) => ({
          id: r.id,
          key: r.key,
          sourceText: r.sourceText,
          translations: (r.translations ?? {}) as Record<string, string>,
          category: r.category,
          active: r.active,
          lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
        }))}
      />
    </div>
  );
}
