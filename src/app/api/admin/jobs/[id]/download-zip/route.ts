import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";
// A job can carry a dozen-plus PDFs (multi-size sticker runs) — give the
// in-memory zip room on slow cold starts.
export const maxDuration = 60;

// One-click "everything in this bundle": zips ALL of a job's generated
// PDFs under their stored file names (the 00-cover / 01-general-
// information prefixes order them inside the archive too) and serves it
// as <style-number>-prod-spec.zip. Assets ship regardless of review
// status — this is the admin-side bundle grab, mirroring what the
// ProdSpec tab shows.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const job = await db.job.findUnique({
    where: { id },
    select: {
      assets: {
        orderBy: { fileName: "asc" },
        select: { fileName: true, pdf: true },
      },
      // Style numbers live in the Monday rawData (resolved at render time),
      // so the archive is named from the style's display name — the PDFs
      // inside already carry the style-number slug in their file names.
      style: { select: { name: true } },
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.assets.length === 0) {
    return NextResponse.json({ error: "Job has no generated documents" }, { status: 404 });
  }

  const zip = new JSZip();
  const taken = new Set<string>();
  for (const asset of job.assets) {
    // fileNames are unique per job in practice (variantKey-derived), but
    // a collision must not silently drop a document from the archive.
    let name = safeFileName(asset.fileName);
    for (let i = 2; taken.has(name); i++) {
      name = safeFileName(asset.fileName).replace(/(\.pdf)?$/i, `-${i}$1`);
    }
    taken.add(name);
    zip.file(name, Buffer.from(asset.pdf));
  }

  const archive = await zip.generateAsync({
    type: "nodebuffer",
    // PDFs are mostly pre-compressed streams — light deflate keeps the
    // CPU cost down without bloating the archive.
    compression: "DEFLATE",
    compressionOptions: { level: 3 },
  });

  const slug = (job.style?.name ?? "style").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  return new NextResponse(new Uint8Array(archive), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}-prod-spec.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_");
}
