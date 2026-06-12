import Link from "next/link";
import { db } from "@/lib/db";
import { LogoImageList } from "./logo-image-list";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function LogosPage() {
  await requireAdminPage();

  const logoImages = await db.logoImage.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Logos</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          The logo library for <code className="font-mono">{"{{logo:custom}}"}</code> on Output
          Builder layouts. The logo is chosen <strong>per style</strong>: upload artwork here, then
          link it from the style&apos;s edit page. A style without a linked logo prints an honest
          &quot;missing&quot; marker that blocks approval.
        </p>
      </div>

      <LogoImageList
        initialLogoImages={logoImages.map((l) => ({
          id: l.id,
          name: l.name,
          image: l.image,
          active: l.active,
        }))}
      />
    </div>
  );
}
