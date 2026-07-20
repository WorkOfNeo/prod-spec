"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// "Email me a reset link". The response is deliberately identical whether
// or not the address exists — better-auth answers the same way server-side
// (it even burns a dummy lookup to keep the timing flat), so this page must
// not leak the difference either. An admin can send the same link from
// /users when someone can't get the email themselves.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    if (error) {
      setError(error.message ?? "Could not send the reset link");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-zinc-700">
          If <strong>{email}</strong> has a Prod Spec account, a reset link is on its way. It
          expires in a couple of hours and can only be used once.
        </p>
        <p className="text-xs text-zinc-500">
          Nothing arrived? Check spam, or ask an admin to send you a link from the People page.
        </p>
        <Link href="/login" className="mt-2 text-center text-xs text-zinc-500 underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500">
        Enter your email and we&apos;ll send you a link to set a new password.
      </p>
      <label className="text-xs font-medium text-zinc-700">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
      <Link href="/login" className="mt-2 text-center text-xs text-zinc-500 underline">
        Back to sign in
      </Link>
    </form>
  );
}
