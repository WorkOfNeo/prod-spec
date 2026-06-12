// Initials-in-a-circle. Shows who owns a review (style page Review tab,
// runs list, claim chip) so the team can follow along at a glance. Pure —
// renders fine from server and client components alike.

const PALETTE = [
  "bg-amber-600",
  "bg-blue-600",
  "bg-violet-600",
  "bg-emerald-600",
  "bg-rose-600",
  "bg-cyan-600",
];

function initialsFor(name: string): string {
  // Emails fall back to the local part ("anna.k@…" → "AK").
  const clean = name.includes("@") ? name.split("@")[0].replace(/[._-]+/g, " ") : name;
  const words = clean.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function colorFor(name: string): string {
  let hash = 7;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function UserAvatar({ name, size = "sm" }: { name: string; size?: "xs" | "sm" }) {
  const dims = size === "xs" ? "h-4 w-4 text-[8px]" : "h-6 w-6 text-[10px]";
  return (
    <span
      title={name}
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white ${dims} ${colorFor(name)}`}
    >
      {initialsFor(name)}
    </span>
  );
}
