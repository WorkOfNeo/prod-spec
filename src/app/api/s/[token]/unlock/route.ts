import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  shareCookieName,
  signShareAccess,
  verifyUnlock,
} from "@/lib/supplier-share/share";

export const runtime = "nodejs";

const SCHEMA = z.object({
  email: z.string().min(1).max(200),
  // 4-digit PIN — accept as string to preserve leading zeros.
  pin: z.string().min(1).max(10),
});

// Public, unauthenticated. The supplier proves access with email + PIN
// (the token is already in the URL). On success we set an httpOnly cookie
// holding HMAC(secret, token) so the PDF endpoints serve bytes for the rest
// of the session without re-entering the PIN.
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and PIN are required" }, { status: 400 });
  }

  const result = await verifyUnlock({ token, email: parsed.data.email, pin: parsed.data.pin });
  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "This link is no longer valid." }, { status: 404 });
    }
    if (result.reason === "locked") {
      return NextResponse.json(
        { error: "Too many incorrect attempts — this link is locked. Contact your buyer to re-issue it." },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: "Email or PIN is incorrect." }, { status: 401 });
  }

  const cookieStore = await cookies();
  cookieStore.set(shareCookieName(token), signShareAccess(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Session-scoped: re-unlock if the browser is fully closed. Generous
    // enough for a single review sitting.
    maxAge: 60 * 60 * 8,
  });

  return NextResponse.json({ ok: true });
}
