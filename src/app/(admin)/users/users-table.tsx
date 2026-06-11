"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "REVIEWER";
  joinedLabel: string;
};

// People panel: inline role switch + remove. The server enforces the
// last-admin guard and blocks self-removal; this UI mirrors those rules
// (no Remove on your own row) and surfaces server errors inline.
export function UsersTable({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setRole(id: string, role: string) {
    setError(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setBusyId(null);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Could not change role");
      return;
    }
    router.refresh();
  }

  async function remove(id: string, email: string) {
    if (!window.confirm(`Remove ${email}? They will be signed out and can no longer log in.`)) return;
    setError(null);
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    setBusyId(null);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Could not remove user");
      return;
    }
    router.refresh();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Email</th>
            <th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Joined</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-zinc-100">
              <td className="px-4 py-3">{u.name}</td>
              <td className="px-4 py-3 text-zinc-600">{u.email}</td>
              <td className="px-4 py-3">
                <select
                  value={u.role}
                  disabled={busyId === u.id}
                  onChange={(e) => setRole(u.id, e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:opacity-50"
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="REVIEWER">REVIEWER</option>
                </select>
              </td>
              <td className="px-4 py-3 text-zinc-500">{u.joinedLabel}</td>
              <td className="px-4 py-3 text-right">
                {u.id === currentUserId ? (
                  <span className="text-xs text-zinc-400">you</span>
                ) : (
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => remove(u.id, u.email)}
                    className="text-xs text-red-600 underline hover:text-red-800 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="border-t border-zinc-100 px-4 py-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
