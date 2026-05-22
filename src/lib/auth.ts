import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { db } from "./db";

const allowlist = (process.env.SIGNUP_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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
        before: async (user) => {
          const email = user.email.toLowerCase();
          if (allowlist.length > 0 && !allowlist.includes(email)) {
            throw new APIError("FORBIDDEN", {
              message: "Signups are restricted to invited emails.",
            });
          }
          const count = await db.user.count();
          return {
            data: { ...user, role: count === 0 ? "ADMIN" : "REVIEWER" },
          };
        },
      },
    },
  },
});
