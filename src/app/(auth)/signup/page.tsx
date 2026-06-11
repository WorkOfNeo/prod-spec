"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

// Signup is invite-only: a valid ?invite=<token> link unlocks the form
// with the email pre-filled and locked. The one exception is bootstrap —
// while the users table is empty the form is open so the first admin can
// claim the instance (gated by SIGNUP_ALLOWLIST server-side). Everything
// shown here is a courtesy preview; the real enforcement is the signup
// hook in src/lib/auth.ts.
type Gate =
  | { state: "checking" }
  | { state: "invited"; email: string }
  | { state: "bootstrap" }
  | { state: "closed" }
  | { state: "dead"; reason: string };

const DEAD_MESSAGES: Record<string, string> = {
  expired: "This invite has expired. Ask an admin to resend it.",
  used: "This invite has already been used.",
  revoked: "This invite is no longer valid.",
  invalid: "This invite link is not valid. Check you copied the full link, or ask an admin for a new one.",
};

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const inviteToken = search.get("invite");

  const [gate, setGate] = useState<Gate>({ state: "checking" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = inviteToken ? `?token=${encodeURIComponent(inviteToken)}` : "";
        const res = await fetch(`/api/invite/validate${params}`);
        const data = (await res.json()) as {
          valid: boolean;
          reason?: string;
          email?: string;
          bootstrap?: boolean;
        };
        if (cancelled) return;
        if (data.valid && data.email) {
          setEmail(data.email);
          setGate({ state: "invited", email: data.email });
        } else if (inviteToken) {
          setGate({ state: "dead", reason: data.reason ?? "invalid" });
        } else if (data.bootstrap) {
          setGate({ state: "bootstrap" });
        } else {
          setGate({ state: "closed" });
        }
      } catch {
        if (!cancelled) setGate(inviteToken ? { state: "dead", reason: "invalid" } : { state: "closed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.signUp.email({
      email,
      password,
      name,
      ...(inviteToken ? { inviteToken } : {}),
    });
    setPending(false);
    if (error) {
      setError(error.message ?? "Sign-up failed");
      return;
    }
    router.push("/styles");
    router.refresh();
  }

  if (gate.state === "checking") {
    return <p className="text-center text-xs text-zinc-500">Checking invite…</p>;
  }

  if (gate.state === "dead" || gate.state === "closed") {
    return (
      <div className="flex flex-col gap-3 text-center">
        <p className="text-sm text-zinc-700">
          {gate.state === "dead"
            ? (DEAD_MESSAGES[gate.reason] ?? DEAD_MESSAGES.invalid)
            : "Signup is by invitation only. Ask an admin for an invite link."}
        </p>
        <Link href="/login" className="text-xs text-zinc-500 underline">
          Already have an account? Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500">
        {gate.state === "invited"
          ? "You've been invited to Prod Spec. Set your name and a password to finish."
          : "You're setting up the first admin account for this instance."}
      </p>
      <label className="text-xs font-medium text-zinc-700">
        Name
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </label>
      <label className="text-xs font-medium text-zinc-700">
        Email
        <input
          type="email"
          required
          value={email}
          readOnly={gate.state === "invited"}
          onChange={(e) => setEmail(e.target.value)}
          className={`mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 ${
            gate.state === "invited" ? "bg-zinc-100 text-zinc-500" : ""
          }`}
        />
      </label>
      <label className="text-xs font-medium text-zinc-700">
        Password (min. 12 chars)
        <input
          type="password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
      <Link href="/login" className="mt-2 text-center text-xs text-zinc-500 underline">
        Already have an account? Sign in
      </Link>
    </form>
  );
}
