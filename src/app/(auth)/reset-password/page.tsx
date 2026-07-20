"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";

// Where the emailed link lands, after better-auth has checked the token and
// bounced us here with ?token=<valid> (or ?error=INVALID_TOKEN if it was
// expired, already spent, or made up). We never see the token before it's
// been vetted, and posting it back is what actually sets the password.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

const MIN_LENGTH = 12;

function ResetPasswordForm() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get("token");
  const linkError = search.get("error");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setError(null);
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (error) {
      setError(error.message ?? "Could not set the new password");
      return;
    }
    setDone(true);
  }

  if (linkError || !token) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-zinc-700">
          This reset link is no longer valid — it may have expired or already been used.
        </p>
        <Link
          href="/forgot-password"
          className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-800"
        >
          Request a new link
        </Link>
        <Link href="/login" className="mt-1 text-center text-xs text-zinc-500 underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-zinc-700">
          Your password has been changed. You&apos;ve been signed out everywhere else — sign in
          again with the new one.
        </p>
        <button
          type="button"
          onClick={() => router.push("/login")}
          className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500">
        Choose a new password — at least {MIN_LENGTH} characters.
      </p>
      <label className="text-xs font-medium text-zinc-700">
        New password
        <input
          type="password"
          required
          minLength={MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </label>
      <label className="text-xs font-medium text-zinc-700">
        Confirm new password
        <input
          type="password"
          required
          minLength={MIN_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
