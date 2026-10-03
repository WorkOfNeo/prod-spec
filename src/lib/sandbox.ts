// =====================================================
// Sandbox mode — the dev/staging kill switch for everything that leaves the
// building.
//
// The development environment runs on a SNAPSHOT of the production database.
// That snapshot carries real supplier folder links, real Monday item ids, real
// supplier emails and whatever work was queued in prod at dump time. Missing
// credentials are the first line of defence (dev should not hold the Monday /
// Azure / Resend keys at all); this switch is the second, so a key pasted into
// the dev environment by mistake still cannot:
//
//   • write to Monday            — gql() refuses any `mutation` (client.ts),
//                                   and writeBackStatus() logs SIMULATED
//   • write to SharePoint        — the Graph client refuses every non-GET
//                                   request (sharepoint/auth.ts)
//   • email anyone               — sendEmail() skips, or redirects every
//                                   message to SANDBOX_EMAIL_TO (email/client.ts)
//
// Reads are untouched: syncing from Monday or reading a supplier folder is
// exactly what you want to test against.
//
// ON when APP_ENV is anything other than "production" AND set — i.e. set
// APP_ENV=development on the dev environment. Unset (prod today) = OFF, so
// production behaviour does not change.
// =====================================================

export function isSandbox(): boolean {
  const env = process.env.APP_ENV?.trim().toLowerCase();
  return Boolean(env) && env !== "production";
}

// Where sandboxed email goes instead of the real recipients. Unset = the
// email is not sent at all (logged and reported as not sent).
export function sandboxEmailTo(): string | null {
  return process.env.SANDBOX_EMAIL_TO?.trim() || null;
}

export class SandboxBlockedError extends Error {
  constructor(what: string) {
    super(`Sandbox mode (APP_ENV=${process.env.APP_ENV}): ${what} is disabled in this environment`);
    this.name = "SandboxBlockedError";
  }
}

// True when a GraphQL document is a mutation. Monday's API takes one operation
// per request, so the leading keyword decides it; comments and whitespace
// before it are skipped. A shorthand `{ … }` document is a query.
export function isGraphqlMutation(query: string): boolean {
  const body = query.replace(/^(?:\s|#[^\n]*\n?)*/, "");
  return /^mutation\b/i.test(body);
}

// Monday gql() choke point: in sandbox mode, reads pass and writes throw.
export function assertMondayWriteAllowed(query: string): void {
  if (isSandbox() && isGraphqlMutation(query)) {
    throw new SandboxBlockedError("Monday write (GraphQL mutation)");
  }
}

// HTTP methods the sandboxed Graph client may still send.
export function isReadOnlyHttpMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}
