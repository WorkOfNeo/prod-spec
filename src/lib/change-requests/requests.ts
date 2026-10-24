import { z } from "zod";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import type { UserRole } from "@/generated/prisma/enums";
import {
  decodeImageAttachments,
  MAX_IMAGE_DATA_URL_CHARS,
  type DecodedAttachment,
} from "@/lib/images/decode-data-url";
import { isLayoutVariantKey, layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { outputPageMm } from "@/lib/output-layouts/render-output";
import { getVariant } from "@/lib/pdf/template-registry";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import { activeStylesWhere } from "@/lib/styles/active-filter";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { orEmpty } from "./db-safe";
import { sendRequesterUpdate } from "./emails";
import { appendMessage } from "./store";
import { requestRef, type OutputStatus, type RequestSource, type RequestStatus } from "./types";

// =====================================================
// Change requests — filing and finding them (design docs/plans/change-requests.md
// §5, §6). The requester's side of the feature:
//
//   createChangeRequest   the /requests/new form's POST: a request, one output
//                         (issue) per picked print output, and the screenshots,
//                         written in ONE transaction so a half-filed request
//                         can't exist.
//   listChangeRequests    the /requests inbox. Reviewers see only their own —
//                         they file for themselves; only an admin works the
//                         whole queue.
//   searchOrders          the form's search box: POs and styles.
//   outputsForStyle       the form's output picker: what a style prints.
//
// Nothing here starts the agent. Filing only records what was asked; the job
// is wired on at integration, and every change it drafts still waits for an
// admin (design §2).
// =====================================================

// ---------- limits ----------

// One request covers at most this many outputs — past that it is several
// requests, and the review screen's tab per output stops being readable.
export const MAX_OUTPUTS = 8;
// Screenshots: a few per output, a ceiling per request. The bytes ride inline
// in the JSON body as data URLs (resized in the browser first) and land in
// Postgres, so the total is what keeps one POST a sane size.
export const MAX_IMAGES_PER_OUTPUT = 4;
export const MAX_IMAGES_TOTAL = 12;

export const MAX_ISSUE_TEXT_CHARS = 20_000;
export const MAX_MESSAGE_CHARS = 50_000;

// ---------- input ----------

// An id-ish optional string. The form sends "" for "not picked"; that means
// absent, not an id to look up.
const optionalRef = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v ? v : undefined));

const AttachmentInputSchema = z.object({
  dataUrl: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS, "Image too large — keep it under ~5 MB"),
  fileName: z.string().max(255).optional(),
});

const OutputInputSchema = z.object({
  label: z.string().trim().min(1, "Every output needs a name").max(200),
  // Base key ("layout:<id>", "care-label-02"); absent when the requester could
  // not point at a configured output. Checked against the style's ProdSpec on
  // create (resolveRequestTargets); the output's layout is read off it, never
  // taken from the client.
  variantKey: optionalRef,
  // The style the agent proves this output on; defaults to the request's style.
  // Must be that style or another style of the same order.
  styleId: optionalRef,
  text: z
    .string()
    .trim()
    .min(1, "Say what should change for every picked output")
    .max(MAX_ISSUE_TEXT_CHARS),
  attachments: z
    .array(AttachmentInputSchema)
    .max(MAX_IMAGES_PER_OUTPUT, `Up to ${MAX_IMAGES_PER_OUTPUT} images per output`)
    .optional(),
});

export const CreateChangeRequestSchema = z
  .object({
    title: optionalRef,
    // The text as written — usually the pasted email. May be empty when every
    // issue was typed straight into the form; the request then stores the
    // issues themselves (composeRequestMessage).
    message: z.string().max(MAX_MESSAGE_CHARS),
    // Only read for "all styles in this PO" (no style picked). With a style,
    // the customer and the order are the style's, whatever was sent.
    customerId: optionalRef,
    poNumber: optionalRef,
    // The picked style. Absent with a PO = "all styles in this PO".
    styleId: optionalRef,
    outputs: z
      .array(OutputInputSchema)
      .min(1, "Pick at least one output")
      .max(MAX_OUTPUTS, `Up to ${MAX_OUTPUTS} outputs per request`),
    // Request-wide screenshots (not tied to one output).
    attachments: z.array(AttachmentInputSchema).max(MAX_IMAGES_TOTAL).optional(),
  })
  .superRefine((v, ctx) => {
    if (countImages(v) > MAX_IMAGES_TOTAL) {
      ctx.addIssue({
        code: "custom",
        path: ["attachments"],
        message: `Up to ${MAX_IMAGES_TOTAL} images per request`,
      });
    }
    // One issue per output: the same output twice would be worked twice and
    // could publish two competing drafts of one layout.
    const seen = new Set<string>();
    v.outputs.forEach((o, i) => {
      if (!o.variantKey) return;
      if (seen.has(o.variantKey)) {
        ctx.addIssue({ code: "custom", path: ["outputs", i, "variantKey"], message: "Each output can be picked once" });
      }
      seen.add(o.variantKey);
    });
  });

export type CreateChangeRequestInput = z.infer<typeof CreateChangeRequestSchema>;
export type CreateChangeRequestOutputInput = CreateChangeRequestInput["outputs"][number];

// A bad request the parser could not catch (an image that doesn't decode, a
// style that is gone). Routes answer 400 with the message.
export class ChangeRequestInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ChangeRequestInputError";
  }
}

export type Actor = { userId: string; role: UserRole | null };

// ---------- pure helpers ----------

export function countImages(input: {
  outputs: ReadonlyArray<{ attachments?: ReadonlyArray<unknown> }>;
  attachments?: ReadonlyArray<unknown>;
}): number {
  return input.outputs.reduce((n, o) => n + (o.attachments?.length ?? 0), input.attachments?.length ?? 0);
}

export type DecodedRequestAttachments = {
  // Index-aligned with input.outputs.
  perOutput: DecodedAttachment[][];
  general: DecodedAttachment[];
};

// Screenshots only. The shared decoder also accepts GIF and SVG (for the
// general-info markdown), but these bytes are served inline from our origin
// and handed to the agent as vision blocks, which take exactly these three.
export const ACCEPTED_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

function decodeScreenshots(
  attachments: { dataUrl: string; fileName?: string }[] | undefined,
): { ok: true; attachments: DecodedAttachment[] } | { ok: false; error: string } {
  const decoded = decodeImageAttachments(attachments);
  if (!decoded.ok) return decoded;
  if (decoded.attachments.some((a) => !ACCEPTED_IMAGE_TYPES.has(a.mimeType))) {
    return { ok: false, error: "Only PNG, JPEG or WebP screenshots can be attached" };
  }
  return decoded;
}

// Decode EVERY image before anything is written, so one bad screenshot 400s
// with nothing half-filed. Re-checks the limits too: the schema is the first
// gate, this is the one a caller cannot skip.
export function decodeRequestAttachments(
  input: Pick<CreateChangeRequestInput, "outputs" | "attachments">,
): { ok: true; attachments: DecodedRequestAttachments } | { ok: false; error: string } {
  if (countImages(input) > MAX_IMAGES_TOTAL) {
    return { ok: false, error: `Up to ${MAX_IMAGES_TOTAL} images per request` };
  }
  const perOutput: DecodedAttachment[][] = [];
  for (const o of input.outputs) {
    if ((o.attachments?.length ?? 0) > MAX_IMAGES_PER_OUTPUT) {
      return { ok: false, error: `Up to ${MAX_IMAGES_PER_OUTPUT} images per output` };
    }
    const decoded = decodeScreenshots(o.attachments);
    if (!decoded.ok) return { ok: false, error: `${o.label}: ${decoded.error}` };
    perOutput.push(decoded.attachments);
  }
  const general = decodeScreenshots(input.attachments);
  if (!general.ok) return { ok: false, error: general.error };
  return { ok: true, attachments: { perOutput, general: general.attachments } };
}

// "Solid polybag sticker · PO-0000", "+2" when the request covers more outputs.
export function defaultRequestTitle(
  outputs: ReadonlyArray<{ label: string }>,
  poNumber?: string | null,
): string {
  const first = outputs[0]?.label.trim() || "Change request";
  const more = outputs.length > 1 ? ` +${outputs.length - 1}` : "";
  const po = poNumber?.trim() ? ` · ${poNumber.trim()}` : "";
  return `${first}${more}${po}`.slice(0, 200);
}

// The request's `message` is the text as the requester wrote it. When nothing
// was pasted, the issues themselves are that text.
export function composeRequestMessage(outputs: ReadonlyArray<{ label: string; text: string }>): string {
  return outputs.map((o) => `${o.label}:\n${o.text.trim()}`).join("\n\n");
}

// The output's layout, read off a `layout:<id>` key — and only from there. A
// layout id from the client would let a request (and the agent's drafts, and
// in the end a publish) point at a layout the picked output doesn't print.
export function resolveLayoutId(output: { variantKey?: string | null }): string | null {
  return layoutIdFromVariantKey(output.variantKey) ?? null;
}

// ---------- targets: what the request may point at ----------

// What the create path knows about a style the body names.
export type StyleFacts = {
  id: string;
  customerId: string;
  poNumber: string | null;
  prodSpecId: string | null;
};

export type TargetFacts = {
  // Every style the body names that exists (not deleted), by id.
  styles: ReadonlyMap<string, StyleFacts>;
  // prodSpecId → the BASE keys of its enabled outputs.
  enabledBaseKeys: ReadonlyMap<string, ReadonlySet<string>>;
};

export type ResolvedTargets = {
  customerId: string | null;
  poNumber: string | null;
  // Index-aligned with input.outputs.
  outputs: { variantKey: string | null; layoutId: string | null; styleId: string | null }[];
};

function samePo(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a?.trim() || null;
  const y = b?.trim() || null;
  return x !== null && x === y;
}

// Everything a request points at, checked against the database instead of
// taken from the client (PURE; facts come from loadTargetFacts):
//
//   • the customer and the order are the picked style's; only "all styles in
//     this PO" (no style) reads them from the body;
//   • an output's style is the request's style or another style of the same
//     order (same customer, same PO);
//   • an output's variantKey is an ENABLED output of the ProdSpec of every
//     style it is tied to (the picked one and its own), matched on the base
//     key and stored as that base key; its layout is read off the key.
//
// Throws ChangeRequestInputError (400) with a message the form can show.
export function resolveRequestTargets(
  input: Pick<CreateChangeRequestInput, "customerId" | "poNumber" | "styleId" | "outputs">,
  facts: TargetFacts,
): ResolvedTargets {
  let customerId = input.customerId ?? null;
  let poNumber = input.poNumber?.trim() || null;
  const picked = input.styleId ? facts.styles.get(input.styleId) : undefined;
  if (input.styleId) {
    if (!picked) throw new ChangeRequestInputError("That style no longer exists — search for it again.");
    customerId = picked.customerId;
    poNumber = picked.poNumber?.trim() || null;
  }

  const prints = (style: StyleFacts, base: string) =>
    style.prodSpecId !== null && (facts.enabledBaseKeys.get(style.prodSpecId)?.has(base) ?? false);

  const seen = new Set<string>();
  const outputs = input.outputs.map((o) => {
    const styleId = o.styleId ?? input.styleId ?? null;
    const own = styleId ? facts.styles.get(styleId) : undefined;
    if (styleId && !own) throw new ChangeRequestInputError(`${o.label}: that style no longer exists — search for it again.`);
    if (own && own.id !== input.styleId) {
      const sameOrder = own.customerId === customerId && samePo(own.poNumber, poNumber);
      if (!sameOrder) {
        throw new ChangeRequestInputError(`${o.label}: the style to prove it on must be one of this order's styles.`);
      }
    }

    if (!o.variantKey) return { variantKey: null, layoutId: null, styleId };
    const base = baseVariantKey(o.variantKey);
    const tied = [picked, own].filter((s, i, all): s is StyleFacts => !!s && all.indexOf(s) === i);
    if (tied.length === 0) {
      throw new ChangeRequestInputError(`${o.label}: pick the style first, so the output can be checked.`);
    }
    if (!tied.every((s) => prints(s, base))) {
      throw new ChangeRequestInputError(`${o.label}: that output isn't printed for this style — pick it again.`);
    }
    if (seen.has(base)) throw new ChangeRequestInputError("Each output can be picked once");
    seen.add(base);
    return { variantKey: base, layoutId: resolveLayoutId({ variantKey: base }), styleId };
  });

  return { customerId, poNumber, outputs };
}

// The facts resolveRequestTargets checks against: the named styles (deleted
// ones count as gone) and the enabled outputs of their ProdSpecs.
export async function loadTargetFacts(
  input: Pick<CreateChangeRequestInput, "styleId" | "outputs">,
): Promise<TargetFacts> {
  const styleIds = [
    ...new Set([input.styleId, ...input.outputs.map((o) => o.styleId)].filter((v): v is string => !!v)),
  ];
  if (styleIds.length === 0) return { styles: new Map(), enabledBaseKeys: new Map() };
  const styles = await db.style.findMany({
    where: { id: { in: styleIds }, deletedAt: null },
    select: { id: true, customerId: true, poNumber: true, prodSpecId: true },
  });
  const specIds = [...new Set(styles.map((s) => s.prodSpecId).filter((v): v is string => !!v))];
  const specs =
    specIds.length > 0
      ? await db.prodSpec.findMany({ where: { id: { in: specIds } }, select: { id: true, outputs: true } })
      : [];
  const enabledBaseKeys = new Map<string, Set<string>>();
  for (const spec of specs) {
    let outputs: ReturnType<typeof parseProdSpecOutputs> = [];
    try {
      outputs = parseProdSpecOutputs(spec.outputs);
    } catch {
      // A malformed outputs column prints nothing; nothing can be picked on it.
    }
    enabledBaseKeys.set(
      spec.id,
      new Set(outputs.filter((o) => o.enabled !== false).map((o) => baseVariantKey(o.variantKey))),
    );
  }
  return { styles: new Map(styles.map((s) => [s.id, s])), enabledBaseKeys };
}

// ---------- create ----------

export async function createChangeRequest(
  input: CreateChangeRequestInput,
  actor: Actor,
): Promise<{ id: string; number: number }> {
  const decoded = decodeRequestAttachments(input);
  if (!decoded.ok) throw new ChangeRequestInputError(decoded.error);
  const { perOutput, general } = decoded.attachments;

  // The customer, the order, each output's style, key and layout: checked
  // against the database, never taken on the client's word (the layout an
  // output names is what a later approval publishes).
  const targets = resolveRequestTargets(input, await loadTargetFacts(input));
  const { customerId, poNumber } = targets;

  // A reviewer files for themselves (and sees only their own); an admin may
  // be filing on someone's behalf.
  const source: RequestSource = isAdmin(actor.role) ? "ADMIN" : "REQUESTER";
  const title = input.title ?? defaultRequestTitle(input.outputs, poNumber);
  const message = input.message.trim() ? input.message : composeRequestMessage(input.outputs);
  const newStatus: RequestStatus = "NEW";
  const newOutputStatus: OutputStatus = "NEW";

  const created = await db.$transaction(
    async (tx) => {
      const request = await tx.changeRequest.create({
        data: {
          title,
          status: newStatus,
          message,
          source,
          createdById: actor.userId,
          customerId,
          poNumber,
          styleId: input.styleId ?? null,
        },
        select: { id: true, number: true },
      });
      const attachmentRows = general.map((a) => ({
        ...a,
        requestId: request.id,
        outputId: null as string | null,
        uploadedById: actor.userId,
      }));
      for (const [position, o] of input.outputs.entries()) {
        const output = await tx.changeRequestOutput.create({
          data: {
            requestId: request.id,
            position,
            label: o.label,
            variantKey: targets.outputs[position].variantKey,
            layoutId: targets.outputs[position].layoutId,
            styleId: targets.outputs[position].styleId,
            text: o.text,
            status: newOutputStatus,
          },
          select: { id: true },
        });
        for (const a of perOutput[position] ?? []) {
          attachmentRows.push({ ...a, requestId: request.id, outputId: output.id, uploadedById: actor.userId });
        }
      }
      if (attachmentRows.length > 0) {
        await tx.changeRequestAttachment.createMany({ data: attachmentRows });
      }
      return request;
    },
    // Up to a dozen screenshots of a few MB each go in with the rows.
    { timeout: 30_000 },
  );

  // Bookkeeping after the commit. The request exists now: a failed status note
  // must not turn into an error that makes the requester file it twice.
  try {
    await appendMessage({ requestId: created.id, authorKind: "SYSTEM", kind: "status", body: "Request received" });
  } catch (err) {
    console.error(`[change-requests] could not post the received note on ${created.id}: ${(err as Error).message}`);
  }
  // Fail-soft by contract: logs, never throws.
  if (source === "REQUESTER") await sendRequesterUpdate(created.id, "received");

  return created;
}

// ---------- list ----------

export type Viewer = { userId: string; role: UserRole | null };

export type ChangeRequestListRow = {
  id: string;
  number: number;
  ref: string;
  title: string;
  status: RequestStatus;
  source: RequestSource;
  poNumber: string | null;
  outputs: { id: string; label: string; status: OutputStatus }[];
  createdById: string;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

// Who sees what. Anyone but an admin is scoped to their own requests — the
// list must never be the place a reviewer reads someone else's report.
export function listWhere(viewer: Viewer, status?: RequestStatus): { createdById?: string; status?: RequestStatus } {
  return {
    ...(isAdmin(viewer.role) ? {} : { createdById: viewer.userId }),
    ...(status ? { status } : {}),
  };
}

export async function listChangeRequests(opts: {
  viewer: Viewer;
  status?: RequestStatus;
  take?: number;
}): Promise<ChangeRequestListRow[]> {
  const take = Math.min(Math.max(opts.take ?? 100, 1), 500);
  const rows = await orEmpty(
    db.changeRequest.findMany({
      where: listWhere(opts.viewer, opts.status),
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        source: true,
        poNumber: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
        outputs: { orderBy: { position: "asc" }, select: { id: true, label: true, status: true } },
      },
    }),
    [],
  );
  // User ids are loose references (no FK), so the creator is a second lookup.
  const creatorIds = [...new Set(rows.map((r) => r.createdById))];
  const users =
    creatorIds.length > 0
      ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, email: true } })
      : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    ref: requestRef(r.number),
    title: r.title,
    status: r.status as RequestStatus,
    source: r.source as RequestSource,
    poNumber: r.poNumber,
    outputs: r.outputs.map((o) => ({ id: o.id, label: o.label, status: o.status as OutputStatus })),
    createdById: r.createdById,
    createdByEmail: emailById.get(r.createdById) ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// ---------- form search ----------

export const SEARCH_LIMIT = 20;

export type OrderSearchPo = {
  poNumber: string;
  customerId: string;
  customerName: string;
  styleCount: number;
  // The PO's first style: "All styles in this PO" lists ITS outputs and proves
  // on it.
  firstStyleId: string | null;
};

export type OrderSearchStyle = {
  id: string;
  name: string;
  poNumber: string | null;
  mondayItemId: string;
  customerId: string;
  customerName: string;
};

export type OrderSearchResult = { pos: OrderSearchPo[]; styles: OrderSearchStyle[] };

// Null when the query is too short to be worth a scan.
export function normalizeSearchQuery(q: string | null | undefined): string | null {
  const trimmed = (q ?? "").trim().slice(0, 100);
  return trimmed.length >= 2 ? trimmed : null;
}

export async function searchOrders(rawQ: string): Promise<OrderSearchResult> {
  const q = normalizeSearchQuery(rawQ);
  if (!q) return { pos: [], styles: [] };

  // The same "active" the /styles list uses — no archived, deleted or parked
  // rows, so the form can't file against an order nobody works on.
  const active = await activeStylesWhere();
  const contains = { contains: q, mode: "insensitive" as const };

  const [poGroups, styles] = await Promise.all([
    db.style.groupBy({
      by: ["poNumber", "customerId"],
      where: { AND: [active, { poNumber: contains }] },
      _count: { _all: true },
      orderBy: { poNumber: "desc" },
      take: SEARCH_LIMIT,
    }),
    db.style.findMany({
      where: { AND: [active, { OR: [{ mondayItemId: contains }, { name: contains }, { poNumber: contains }] }] },
      orderBy: [{ poNumber: "desc" }, { name: "asc" }],
      take: SEARCH_LIMIT,
      select: {
        id: true,
        name: true,
        poNumber: true,
        mondayItemId: true,
        customerId: true,
        customer: { select: { name: true } },
      },
    }),
  ]);

  const groups = poGroups.filter((g): g is typeof g & { poNumber: string } => Boolean(g.poNumber));
  const poNumbers = [...new Set(groups.map((g) => g.poNumber))];
  const customerIds = [...new Set(groups.map((g) => g.customerId))];
  const [customers, firsts] = await Promise.all([
    customerIds.length > 0
      ? db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    poNumbers.length > 0
      ? db.style.findMany({
          where: { AND: [active, { poNumber: { in: poNumbers } }] },
          orderBy: { createdAt: "asc" },
          distinct: ["poNumber", "customerId"],
          select: { id: true, poNumber: true, customerId: true },
        })
      : Promise.resolve([]),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const firstStyle = new Map(firsts.map((s) => [`${s.poNumber}\u0000${s.customerId}`, s.id]));

  return {
    pos: groups.map((g) => ({
      poNumber: g.poNumber,
      customerId: g.customerId,
      customerName: customerName.get(g.customerId) ?? "",
      styleCount: g._count._all,
      firstStyleId: firstStyle.get(`${g.poNumber}\u0000${g.customerId}`) ?? null,
    })),
    styles: styles.map((s) => ({
      id: s.id,
      name: s.name,
      poNumber: s.poNumber,
      mondayItemId: s.mondayItemId,
      customerId: s.customerId,
      customerName: s.customer.name,
    })),
  };
}

// ---------- output picker ----------

export type StyleOutputOption = {
  variantKey: string;
  label: string;
  // The printed page box — what the thumbnail is drawn at.
  widthMm: number;
  heightMm: number;
  isLayout: boolean;
};

// The style's enabled outputs, labelled the way the style page labels them.
// Null when the style doesn't exist.
export async function outputsForStyle(styleId: string): Promise<StyleOutputOption[] | null> {
  const ctx = await loadStyleRenderContext(styleId);
  if (!ctx) return null;
  await ensureLayoutVariantsLoaded();
  const sizeMap = await loadInfoAreaSizeMap();

  // A layout that isn't published has no registry entry; name it from the
  // table so the picker never shows a bare key.
  const unregistered = ctx.outputs
    .filter((o) => !getVariant(o.variantKey))
    .map((o) => layoutIdFromVariantKey(o.variantKey))
    .filter((id): id is string => Boolean(id));
  const layoutNames =
    unregistered.length > 0
      ? new Map(
          (
            await orEmpty(
              db.outputLayout.findMany({ where: { id: { in: unregistered } }, select: { id: true, name: true } }),
              [],
            )
          ).map((l) => [l.id, l.name]),
        )
      : new Map<string, string>();

  const seen = new Set<string>();
  const options: StyleOutputOption[] = [];
  for (const o of ctx.outputs) {
    if (seen.has(o.variantKey)) continue;
    seen.add(o.variantKey);
    const variant = getVariant(o.variantKey);
    const dims = effectiveOutputDims(o, variant?.isInfoArea ?? false, sizeMap);
    const page = variant ? outputPageMm(variant, dims) : dims;
    const layoutId = layoutIdFromVariantKey(o.variantKey);
    options.push({
      variantKey: o.variantKey,
      label: variant?.name ?? (layoutId ? layoutNames.get(layoutId) : undefined) ?? o.variantKey,
      widthMm: page.widthMm,
      heightMm: page.heightMm,
      isLayout: isLayoutVariantKey(o.variantKey),
    });
  }
  return options;
}
