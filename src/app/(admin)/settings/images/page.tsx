import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/auth-server";
import { ImageList } from "./image-list";

export const dynamic = "force-dynamic";

export const metadata = { title: "Images" };

export default async function LayoutImagesPage() {
  await requireAdminPage();

  const [images, layouts] = await Promise.all([
    db.layoutImage.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    // Which layouts place each picture — shown on the card so it's obvious
    // what a rename or a delete would hit. Matched in JS because the
    // reference lives inside the layout's JSON definition.
    db.outputLayout.findMany({ select: { name: true, definition: true } }),
  ]);

  const usageBySlug = new Map<string, string[]>();
  for (const image of images) {
    const needle = `{{image:${image.slug}`; // prefix — also matches a width arg
    usageBySlug.set(
      image.slug,
      layouts
        .filter((l) => JSON.stringify(l.definition ?? {}).includes(needle))
        .map((l) => l.name)
        .sort(),
    );
  }

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Images</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Shared artwork for the Output Builder. Place a picture on a layout with{" "}
          <code className="font-mono">{"{{image:<name>}}"}</code> — as many as an output needs, and the
          same picture on as many layouts as you like. Correct it here and every layout that places it
          follows. Add a width to size one:{" "}
          <code className="font-mono">{"{{image:coop-hanger:40}}"}</code> prints it at 40% of its
          block&apos;s width; without a width it matches the block&apos;s font size.
        </p>
      </div>

      <ImageList
        initialImages={images.map((i) => ({
          id: i.id,
          name: i.name,
          slug: i.slug,
          image: i.image,
          active: i.active,
          usedBy: usageBySlug.get(i.slug) ?? [],
        }))}
      />
    </div>
  );
}
