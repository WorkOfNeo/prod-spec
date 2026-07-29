import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import {
  getFileNamePresets,
  getFileNamePresetsRow,
  setFileNamePresets,
  type FileNamePreset,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// Shared library of "Output file name" patterns for the Output Builder.
//
//   GET                          → { presets: [{ id, label, pattern }] }
//   POST { label, pattern }      → add (or update the label of an existing
//                                  identical pattern) → { presets }
//   POST { deleteId }            → remove one → { presets }
//
// The whole list is returned on every call so the editor never has to
// reconcile — it just replaces its copy.

const BODY_SCHEMA = z.union([
  z.object({
    label: z.string().trim().max(80).optional(),
    pattern: z.string().trim().min(1).max(160),
  }),
  z.object({ deleteId: z.string().trim().min(1).max(60) }),
]);

let presetSeq = 0;
function newPresetId(): string {
  presetSeq += 1;
  return `fnp-${Date.now().toString(36)}-${presetSeq}`;
}

// The two house conventions, seeded ONCE (on the first read, when the
// AppSetting row doesn't exist yet) so the library isn't empty on day one.
// Seeding writes the row, so a later deletion sticks — this can't resurrect
// a preset someone removed on purpose.
const SEED: ReadonlyArray<{ label: string; pattern: string }> = [
  { label: "Price Sticker", pattern: "{{styleNumber}}-{{colourName}}-{{size}}-Price Sticker" },
  { label: "Carton Marking", pattern: "{{styleNumber}}-{{colourName}}-{{size}}-Carton Marking" },
];

export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const stored = await getFileNamePresetsRow();
  if (stored === null) {
    const seeded = SEED.map((s) => ({ id: newPresetId(), ...s }));
    return NextResponse.json({ presets: await setFileNamePresets(seeded) });
  }
  return NextResponse.json({ presets: stored });
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const current = await getFileNamePresets();

  const data = parsed.data;
  if ("deleteId" in data) {
    const next = current.filter((p) => p.id !== data.deleteId);
    return NextResponse.json({ presets: await setFileNamePresets(next) });
  }

  const { pattern } = data;
  const label = data.label?.trim() || pattern;
  // Same pattern saved twice = one entry, keeping the newest label — saving
  // from two layouts that share a convention shouldn't grow the list.
  const existing = current.find((p) => p.pattern === pattern);
  const next: FileNamePreset[] = existing
    ? current.map((p) => (p.id === existing.id ? { ...p, label } : p))
    : [...current, { id: newPresetId(), label, pattern }];

  return NextResponse.json({ presets: await setFileNamePresets(next) });
}
