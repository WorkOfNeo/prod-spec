import type { NextRequest } from "next/server";

export type MondayChallengeBody = { challenge: string };

// Direct create_webhook subscriptions don't sign payloads by default. We
// authenticate by adding a `?token=` query param to the registered URL,
// then matching it here against MONDAY_WEBHOOK_SECRET.
export function verifyWebhookRequest(req: NextRequest): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.MONDAY_WEBHOOK_SECRET;
  if (!expected) return { ok: false, reason: "MONDAY_WEBHOOK_SECRET not configured" };
  const tokenFromQuery = req.nextUrl.searchParams.get("token");
  if (tokenFromQuery && safeEqual(tokenFromQuery, expected)) return { ok: true };
  const auth = req.headers.get("authorization");
  if (auth && safeEqual(auth, expected)) return { ok: true };
  return { ok: false, reason: "Invalid or missing webhook token" };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function isChallenge(body: unknown): body is MondayChallengeBody {
  return typeof body === "object" && body !== null && typeof (body as { challenge?: unknown }).challenge === "string";
}

export type MondayEventBody = {
  event: {
    type: string;
    pulseId?: number;
    boardId?: number;
    columnId?: string;
    value?: unknown;
    previousValue?: unknown;
    userId?: number;
  };
};

export function isEventPayload(body: unknown): body is MondayEventBody {
  return typeof body === "object" && body !== null && typeof (body as { event?: unknown }).event === "object";
}
