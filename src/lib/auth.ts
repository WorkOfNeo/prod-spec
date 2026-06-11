import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { db } from "./db";
import { checkInviteToken, consumeInvite } from "./invites/invites";

// Bootstrap-only allowlist: consulted ONLY while the users table is empty,
// to let the very first admin in without an invite (nobody exists yet to
// create one). After that, signup is invite-only — see the hooks below.
const allowlist = (process.env.SIGNUP_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// The signup request carries the invite token as an extra body field
// (authClient.signUp.email({ ..., inviteToken })). better-auth's signup
// body schema is .and(z.record(...)) so the field survives validation, and
// hooks receive the endpoint context via AsyncLocalStorage — verified
// against better-auth 1.6.11 (dist/api/routes/sign-up.mjs, db/with-hooks.mjs).
function inviteTokenFrom(ctx: unknown): string | null {
  const body = (ctx as { body?: Record<string, unknown> } | null | undefined)?.body;
  const token = body?.inviteToken;
  return typeof token === "string" && token ? token : null;
}

export const auth = betterAuth({
  appName: "Prod Spec",
  database: prismaAdapter(db, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 12,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        input: false,
        required: false,
        defaultValue: "REVIEWER",
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Gatekeeper — runs BEFORE the user row is written, so a bad
        // invite never creates an account. Two doors:
        //   1. Empty users table → bootstrap: allowlist email, no token
        //      needed, becomes ADMIN.
        //   2. Anyone after that → a live single-use invite for exactly
        //      this email; role comes from the invite.
        before: async (user, ctx) => {
          const email = user.email.toLowerCase();
          const userCount = await db.user.count();

          if (userCount === 0) {
            if (allowlist.length > 0 && !allowlist.includes(email)) {
              throw new APIError("FORBIDDEN", {
                message: "Signups are restricted. Ask an admin for an invite link.",
              });
            }
            return { data: { ...user, role: "ADMIN" } };
          }

          const check = await checkInviteToken(inviteTokenFrom(ctx));
          if (!check.valid) {
            const message =
              check.reason === "expired"
                ? "This invite link has expired. Ask an admin to resend it."
                : check.reason === "used"
                  ? "This invite link has already been used. Try signing in instead."
                  : "Signup is by invitation only. Ask an admin for an invite link.";
            throw new APIError("FORBIDDEN", { message });
          }
          if (check.invite.email !== email) {
            throw new APIError("FORBIDDEN", {
              message: "This invite link is for a different email address.",
            });
          }
          return { data: { ...user, role: check.invite.role } };
        },
        // The user now exists → spend the invite (guarded update: only a
        // still-pending invite flips, so a forwarded link can't onboard a
        // second person). Bootstrap signups carry no token — no-op.
        after: async (user, ctx) => {
          const token = inviteTokenFrom(ctx);
          if (!token) return;
          await consumeInvite(token, user.id);
        },
      },
    },
  },
});
