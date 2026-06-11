import { Resend } from "resend";

// Every system email leaves from this address. EMAIL_FROM (env) overrides
// it; the domain must be verified in Resend either way.
const DEFAULT_FROM = "Prod Spec <prodspec@contrast.dk>";

export function emailFromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
}

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
  // Carbon-copy recipients (e.g. the supplier's contact person).
  cc?: string | string[];
  // File attachments. `content` is the raw bytes; Resend base64-encodes it.
  attachments?: Array<{ filename: string; content: Buffer }>;
  // Per-send sender override (manual real-sends from the email dialog).
  // Defaults to emailFromAddress(); the domain must be verified in Resend.
  from?: string;
};

export async function sendEmail(opts: SendOpts): Promise<{ id?: string; sent: boolean }> {
  const resend = getResend();
  if (!resend) {
    console.warn("[email] skipping send — RESEND_API_KEY not set");
    return { sent: false };
  }
  const { data, error } = await resend.emails.send({
    ...opts,
    from: opts.from?.trim() || emailFromAddress(),
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return { id: data?.id, sent: true };
}
