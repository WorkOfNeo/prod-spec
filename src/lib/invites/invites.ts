import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import type { Invite } from "@/generated/prisma/client";
import type { UserRole } from "@/generated/prisma/enums";

// =====================================================
// Single-use signup invitations. All the rules live here; the routes and
// the auth hook (src/lib/auth.ts) stay thin.
//
// Lifecycle: created (pending) → used | revoked | expired. Status is
// DERIVED from the timestamps — never stored — so it can't drift.
// A link only works while pending; consumption is a guarded updateMany
// (usedAt IS NULL) so a race between two submits resolves to one winner.
// =====================================================

export const INVITE_TTL_DAYS = 7;

export type InviteStatus = "PENDING" | "USED" | "REVOKED" | "EXPIRED";

export type InviteRejection = "missing" | "invalid" | "used" | "revoked" | "expired";

export type TokenCheck =
  | { valid: true; invite: Invite }
  | { valid: false; reason: InviteRejection };

export function inviteStatus(invite: {
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InviteStatus {
  if (invite.usedAt) return "USED";
  if (invite.revokedAt) return "REVOKED";
  if (invite.expiresAt < new Date()) return "EXPIRED";
  return "PENDING";
}

export function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

export function buildInviteLink(token: string): string {
  const base = (
    process.env.PROD_SPEC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  return `${base}/signup?invite=${encodeURIComponent(token)}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

// Create a fresh invite for an email. Any still-pending invite for the
// same address is revoked first — one live link per person, the newest
// one — so "re-invite" never leaves two working tokens in the wild.
export async function createInvite(input: {
  email: string;
  role: UserRole;
  invitedById: string;
}): Promise<Invite> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  return db.$transaction(async (tx) => {
    await tx.invite.updateMany({
      where: { email, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    return tx.invite.create({
      data: {
        token: generateInviteToken(),
        email,
        role: input.role,
        expiresAt: addDays(now, INVITE_TTL_DAYS),
        invitedById: input.invitedById,
      },
    });
  });
}

// Is this token currently good for signing up? Used by the public
// validate route (friendly pre-check) AND re-run inside the signup hook
// (the actual enforcement) — same rules in both places by construction.
export async function checkInviteToken(token: string | null | undefined): Promise<TokenCheck> {
  if (!token) return { valid: false, reason: "missing" };
  let invite: Invite | null;
  try {
    invite = await db.invite.findUnique({ where: { token } });
  } catch (err) {
    // Table missing (P2021 — migration not applied yet): fail CLOSED with
    // a normal "invalid" so signup stays locked rather than crashing.
    if (isMissingInvitesTable(err)) {
      console.warn(
        `[invites] invites table unavailable (run npm run db:deploy?): ${(err as Error).message}`,
      );
      return { valid: false, reason: "invalid" };
    }
    throw err;
  }
  if (!invite) return { valid: false, reason: "invalid" };
  if (invite.usedAt) return { valid: false, reason: "used" };
  if (invite.revokedAt) return { valid: false, reason: "revoked" };
  if (invite.expiresAt < new Date()) return { valid: false, reason: "expired" };
  return { valid: true, invite };
}

// Spend the invite after the user row exists. Guarded so it's idempotent
// and race-safe: only a still-pending invite flips; the loser of a
// concurrent submit updates 0 rows.
export async function consumeInvite(token: string, userId: string): Promise<void> {
  await db.invite.updateMany({
    where: { token, usedAt: null, revokedAt: null },
    data: { usedAt: new Date(), usedById: userId },
  });
}

export async function revokeInvite(id: string): Promise<Invite | null> {
  const result = await db.invite.updateMany({
    where: { id, usedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return null;
  return db.invite.findUnique({ where: { id } });
}

// "Resend" gives the invitee a fresh window on the SAME link — meaningful
// for expired invites too (the common case for resending). Used and
// revoked invites stay dead.
export async function extendInvite(id: string): Promise<Invite | null> {
  const result = await db.invite.updateMany({
    where: { id, usedAt: null, revokedAt: null },
    data: { expiresAt: addDays(new Date(), INVITE_TTL_DAYS) },
  });
  if (result.count === 0) return null;
  return db.invite.findUnique({ where: { id } });
}

// "The invites infrastructure isn't there yet": P2021 = table missing in
// the DB (migration not deployed), TypeError = db.invite undefined because
// a running dev server still holds the pre-invites Prisma client on
// globalThis (restart picks up the regenerated one). Both degrade the same
// way: invites unavailable, signup stays closed, nothing crashes.
export function isMissingInvitesTable(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2021"
  );
}
