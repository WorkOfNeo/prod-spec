import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";

export const runtime = "nodejs";
// One puppeteer render.
export const maxDuration = 120;

// "Show me a real one." — type a style number, get the actual cover PDF that
// style would produce with Monday's trims folded in.
//
// The before/after panel shows the manifest as data, which is the right shape
// for scanning many styles at once but is not the page anyone will hold. This
// renders the genuine article, through the same buildStyleCoverPdf that publish
// uses, so what comes back is a real cover and not a mock-up of one.
//
// TWO PROPERTIES THAT MAKE IT SAFE TO USE WHILE THE MASTER SWITCH IS OFF:
//
//   1. forceTrims. The whole reason to look at a sample is to decide whether to
//      turn the switch on, so the sample must ignore it. That bypass is
//      confined to callers that hand the bytes straight back.
//   2. Nothing is persisted. No JobAsset is written, no queue row is armed, no
//      fingerprint is stamped, nothing is pushed to SharePoint and no supplier
//      is emailed. The PDF is rendered, returned, and forgotten — so a person
//      can look at a hundred of them and the estate is untouched.
//
//   GET /api/admin/settings/cover-page/sample-pdf?style=<style number>

export async function GET(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const query = (req.nextUrl.searchParams.get("style") ?? "").trim();
  if (!query) return NextResponse.json({ error: "Pass ?style=<style number>" }, { status: 400 });

  // Style.name carries the style number in this data (IL63378 and the like).
  // Exact match first so a precise entry can't be beaten by a longer partial;
  // fall back to contains so a half-remembered number still finds something.
  const style =
    (await db.style.findFirst({
      where: { name: { equals: query, mode: "insensitive" }, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    })) ??
    (await db.style.findFirst({
      where: { name: { contains: query, mode: "insensitive" }, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    }));

  if (!style) {
    return NextResponse.json({ error: `No style matches "${query}"` }, { status: 404 });
  }

  // buildStyleCoverPdf renders from a JOB (it needs the style data the job was
  // built from), so the newest non-failed job stands in. A style that has never
  // generated has no job to render against — say so plainly rather than
  // returning an empty page.
  const job = await db.job.findFirst({
    where: { styleId: style.id, status: { not: "FAILED" } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!job) {
    return NextResponse.json(
      { error: `${style.name} has never generated a bundle, so there is no cover to render.` },
      { status: 409 },
    );
  }

  // Lazy: the render chain pulls in puppeteer, and neither the validation nor
  // the two lookups above need it. Loading it only once we are certain we will
  // render keeps a bad style number a cheap 404 instead of a cold start behind
  // the whole PDF stack.
  const { buildStyleCoverPdf } = await import("@/lib/pdf/style-cover");
  const { approvedOutputBaseKeysForStyle } = await import("@/lib/outputs/current-outputs");

  const approvedBases = await approvedOutputBaseKeysForStyle(style.id);
  const pdf = await buildStyleCoverPdf(job.id, approvedBases, { forceTrims: true });
  if (!pdf) {
    return NextResponse.json({ error: `Could not render a cover for ${style.name}.` }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // inline: this is meant to be looked at, not downloaded and filed.
      "Content-Disposition": `inline; filename="${style.name}-cover-sample.pdf"`,
      // A sample is a snapshot of live config; caching one would show a
      // stale page the moment a trim rule is edited, which is the exact
      // moment somebody re-checks.
      "Cache-Control": "no-store",
      "X-Cover-Sample-Style": style.name,
      "X-Cover-Sample-Variant": COVER_VARIANT_KEY,
    },
  });
}
