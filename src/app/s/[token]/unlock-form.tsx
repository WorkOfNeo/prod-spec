"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Email + 4-digit PIN gate for a supplier share. On success the unlock API
// sets the access cookie; we refresh so the server page re-renders with the
// approved PDFs.
export function UnlockForm({ token }: { token: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/s/${token}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), pin: pin.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Could not unlock (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-zinc-900">View your approved prod specs</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Enter the email address this link was sent to, and the 4-digit PIN from that email.
      </p>

      <label className="mt-4 block text-xs font-medium text-zinc-600" htmlFor="ss-email">
        Email
      </label>
      <input
        id="ss-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@supplier.com"
        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
      />

      <label className="mt-3 block text-xs font-medium text-zinc-600" htmlFor="ss-pin">
        PIN
      </label>
      <input
        id="ss-pin"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={4}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        placeholder="1234"
        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-center font-mono text-lg tracking-[0.4em] focus:ring-2 focus:ring-zinc-900 focus:outline-none"
      />

      {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={pending || email.trim() === "" || pin.length < 4}
        className="mt-4 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Unlocking…" : "Unlock"}
      </button>
    </form>
  );
}
