import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { publishApprovedJob, PublishError } from "@/lib/publish/publish-approved-job";

export const runtime = "nodejs";
export const maxDuration = 120;

// Job-level "Approve all & publish": cascades approval to every pending
// asset, uploads to SharePoint (when configured) and emails the supplier.
// All the actual work lives in src/lib/publish/publish-approved-job.ts,
// shared with the per-asset roll-up path.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  try {
    const result = await publishApprovedJob(id, session.user.id);
    return NextResponse.json({
      ok: true,
      uploaded: result.uploaded,
      notification: result.notification,
      email: result.email,
    });
  } catch (err) {
    if (err instanceof PublishError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
