import { createHmac, randomBytes, randomInt, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

// =====================================================
// Supplier share — server helpers for the supplier-facing approved-PDF link.
//
// Access model (chosen by the team): the URL carries an unguessable token
// (/s/<token>); the supplier must additionally type their email + a 4-digit
// PIN to unlock. The token is the primary secret; the PIN is the second
// factor and is carried in the approval email. A successful unlock records
// a visit and sets a signed cookie so the PDF endpoints can serve bytes for
// the rest of the session without re-entering the PIN.
// =====================================================

// Wrong-PIN attempts allowed before the share locks. Generous — a legit
// supplier mistyping a 4-digit PIN shouldn't get locked out, but this caps
// brute force behind the already-unguessable token. Reset to 0 on success.
const MAX_FAILED_ATTEMPTS = 15;

// Cookie + access-token signing. BETTER_AUTH_SECRET is always set in this
// app (Better-Auth requires it); fall back to JOB_RUNNER_SECRET only so
// local tooling without the auth secret still functions.
function signingSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JOB_RUNNER_SECRET;
  if (!secret) {
    throw new Error("No BETTER_AUTH_SECRET / JOB_RUNNER_SECRET set — cannot sign supplier-share access");
  }
  return secret;
}

export function shareCookieName(token: string): string {
  return `ss_${token}`;
}

// Proof-of-unlock value stored in the cookie: HMAC(secret, token). The
// client can't forge it without the server secret, and we only set it after
// a correct email + PIN. The PDF endpoints recompute and compare.
export function signShareAccess(token: string): string {
  return createHmac("sha256", signingSecret()).update(token).digest("hex");
}

export function verifyShareAccess(token: string, cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const expected = signShareAccess(token);
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return nodeTimingSafeEqual(a, b);
}

function generateToken(): string {
  // 24 random bytes → 32-char url-safe string. Unguessable.
  return randomBytes(24).toString("base64url");
}

function generatePin(): string {
  // 4-digit, zero-padded. crypto.randomInt for an unbiased value.
  return String(randomInt(0, 10000)).padStart(4, "0");
}

export function shareUrl(token: string): string {
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${base}/s/${token}`;
}

export type CreatedShare = { token: string; pin: string; email: string; url: string };

// Create or refresh the ONE durable share for a style. The link is stable:
// on re-approval we KEEP the existing token + PIN (so the supplier's
// bookmark and the previously-sent email keep working) and only refresh the
// gated `email`. The portal always serves the style's latest approved
// version, so a correction "pushes through" to this same link. `email` is
// the recipient the latest approval went to — the address the unlock form
// checks against; pass "" when no supplier email resolved (the share still
// exists so the team can read the link + PIN off the prod-spec tab).
export async function upsertShareForStyle(input: {
  styleId: string;
  email: string;
}): Promise<CreatedShare> {
  const existing = await db.supplierShare.findUnique({
    where: { styleId: input.styleId },
    select: { token: true, pin: true },
  });
  if (existing) {
    // Keep token + PIN + visit history; just refresh the gated email.
    await db.supplierShare.update({
      where: { styleId: input.styleId },
      data: { email: input.email },
    });
    return { token: existing.token, pin: existing.pin, email: input.email, url: shareUrl(existing.token) };
  }
  const token = generateToken();
  const pin = generatePin();
  await db.supplierShare.create({
    data: { styleId: input.styleId, token, pin, email: input.email },
  });
  return { token, pin, email: input.email, url: shareUrl(token) };
}

export type UnlockResult =
  | { ok: true; firstVisit: boolean }
  | { ok: false; reason: "not_found" | "locked" | "invalid" };

// Validate an unlock attempt (email + PIN) against the token's share.
// Records a visit on success, increments failedAttempts on a wrong PIN.
export async function verifyUnlock(input: {
  token: string;
  email: string;
  pin: string;
}): Promise<UnlockResult> {
  const share = await db.supplierShare.findUnique({ where: { token: input.token } });
  if (!share) return { ok: false, reason: "not_found" };
  if (share.failedAttempts >= MAX_FAILED_ATTEMPTS) return { ok: false, reason: "locked" };

  const emailOk = share.email.trim().toLowerCase() === input.email.trim().toLowerCase();
  const pinOk = constantTimeEqual(share.pin, input.pin.trim());
  if (!emailOk || !pinOk) {
    await db.supplierShare.update({
      where: { id: share.id },
      data: { failedAttempts: { increment: 1 } },
    });
    return { ok: false, reason: "invalid" };
  }

  const firstVisit = share.firstVisitedAt === null;
  const now = new Date();
  await db.supplierShare.update({
    where: { id: share.id },
    data: {
      failedAttempts: 0,
      visitCount: { increment: 1 },
      lastVisitedAt: now,
      ...(firstVisit ? { firstVisitedAt: now } : {}),
    },
  });
  return { ok: true, firstVisit };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}
