import { Resend } from "resend";

let cached: Resend | null = null;

export function getResend(): Resend | null {
  if (cached) return cached;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  cached = new Resend(key);
  return cached;
}

export type SendOpts = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
};

export async function sendEmail(opts: SendOpts): Promise<{ id?: string; sent: boolean }> {
  const resend = getResend();
  const from = process.env.EMAIL_FROM;
  if (!resend || !from) {
    console.warn("[email] skipping send — RESEND_API_KEY or EMAIL_FROM not set");
    return { sent: false };
  }
  const { data, error } = await resend.emails.send({ from, ...opts });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return { id: data?.id, sent: true };
}
