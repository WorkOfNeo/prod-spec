import Link from "next/link";
import { db } from "@/lib/db";
import { QrImageList } from "./qr-image-list";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function QrCodesPage() {
  await requireAdminPage();

  const qrImages = await db.qrImage.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">QR codes</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Uploaded QR images, rendered on Care Label 02 (page 4). These are plain images — nothing
          is generated here. Link one to a style from the style&apos;s edit page; the linked QR
          prints as-is.
        </p>
      </div>

      <QrImageList
        initialQrImages={qrImages.map((q) => ({
          id: q.id,
          name: q.name,
          image: q.image,
          active: q.active,
        }))}
      />
    </div>
  );
}
