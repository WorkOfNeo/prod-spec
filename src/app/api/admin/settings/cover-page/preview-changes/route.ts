import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { diffCoverManifests, listCoverStyleIds } from "@/lib/pdf/cover-manifest-diff";
import { loadTrimSettings } from "@/lib/outputs/required-packaging";

export const runtime = "nodejs";
export const maxDuration = 300;

// Before/after for the cover manifest, chunked exactly like the regen sweep it
// precedes — the client prepares the id list once, then walks it in bounded
// requests and shows what it finds as it goes. Same chunking discipline for the
// same reason: each request has to finish inside maxDuration, and a person has
// to be able to watch it and stop.
//
// READ-ONLY. Nothing here renders a PDF, arms a queue row or touches
// SharePoint; it is the look-before-you-leap half of the regen flow.
//
//   POST { mode: "prepare" }                  -> { styleIds, total }
//   POST { mode: "scan", styleIds: [...] }    -> { diffs, changedCount }

const PREPARE = z.object({
  mode: z.literal("prepare"),
  prodSpecId: z.string().min(1).optional(),
});

const SCAN = z.object({
  mode: z.literal("scan"),
  // Each style costs two full manifest builds, so the chunk is smaller than the
  // regen sweep's.
  styleIds: z.array(z.string().min(1)).min(1).max(25),
  // Drop the row arrays and return counts only. The full manifests are what
  // make the sample readable, but shipping them for all ~1,800 styles is
  // megabytes of JSON nobody looks at.
  countsOnly: z.boolean().default(false),
});

const BODY = z.discriminatedUnion("mode", [PREPARE, SCAN]);

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  if (parsed.data.mode === "prepare") {
    const styleIds = await listCoverStyleIds({ prodSpecId: parsed.data.prodSpecId });
    return NextResponse.json({ styleIds, total: styleIds.length });
  }

  const trimSettings = await loadTrimSettings();
  const { diffs, changedCount } = await diffCoverManifests(parsed.data.styleIds, { trimSettings });

  return NextResponse.json({
    changedCount,
    diffs: parsed.data.countsOnly
      ? diffs.map((d) => ({
          styleId: d.styleId,
          styleName: d.styleName,
          customerName: d.customerName,
          poNumber: d.poNumber,
          changed: d.changed,
          addedRows: d.addedRows,
          before: [],
          after: [],
        }))
      : diffs,
  });
}
