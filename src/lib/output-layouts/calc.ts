import { tokenMeta, parseSiblingTokenKey } from "./token-meta";

// =====================================================
// Calculated fields — the {{= expression }} token. CLIENT-SAFE (builder
// validation and canvas highlighting import this), like schema.ts /
// token-meta.ts. The StyleData-backed evaluation context is wired up in
// tokens.ts (evaluateCalcForStyle); this module owns the grammar, the
// parser, the evaluator and validation so the renderer, readiness and the
// publish gate can never disagree on what an expression means.
//
// Grammar (one line, evaluated AFTER conditionals, BEFORE plain tokens):
//   expr    := term (("+" | "-") term)*
//   term    := unary (("*" | "/") unary)*
//   unary   := "-"? primary
//   primary := number | field | fn "(" … ")" | "(" expr ")"
//   fn      := sum | count | min | max   (one field argument)
//            | round                      (expr, optional decimals literal)
//
// Field identifiers are the ordinary text-token keys ({{qtyPerCarton}}
// without braces); sibling slot keys (style2QtyPerCarton) work too.
// Empty-value rules:
//   • a SIBLING reference (slot ≥ 2) that resolves empty counts as 0 —
//     "add style 2 if it's there" never fails when it isn't;
//   • a BASE field that resolves empty/non-numeric makes the whole calc
//     unresolved (a real data gap — same surfacing as an empty token);
//   • sum/min/max skip empty sibling slots but require a numeric base;
//     count() just counts non-empty slots and never comes up unresolved.
// =====================================================

// {{= expr }} — the body carries no braces, so the match can't run past
// its own "}}" or half-eat a neighbouring {{token}}. "={{" is impossible:
// TOKEN_RE requires a letter after "{{", so the two grammars are disjoint
// (the same trick {{if …}} uses via its mandatory space).
export const CALC_RE = /\{\{=\s*([^{}]*?)\s*\}\}/g;

export const CALC_AGG_FNS = ["sum", "count", "min", "max"] as const;
export type CalcAggFn = (typeof CALC_AGG_FNS)[number];

export type CalcNode =
  | { t: "num"; v: number }
  | { t: "field"; key: string }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; l: CalcNode; r: CalcNode }
  | { t: "agg"; fn: CalcAggFn; field: string }
  | { t: "round"; expr: CalcNode; decimals: number };

// The fields an aggregate can walk across carton slots — exactly the
// SIBLING_FIELDS projection (token-meta.ts), keyed by the BASE token name
// the operator writes: sum(qtyPerCarton) reads slot 1's {{qtyPerCarton}}
// and every active sibling's QtyPerCarton. Values are the canonical
// SiblingStyle suffix tokens.ts resolves per slot.
export const AGGREGATE_FIELDS: Record<string, string> = {
  styleNumber: "Number",
  styleName: "Name",
  description: "Description",
  customerItemNo: "CustomerItemNo",
  colourName: "ColourName",
  colourCode: "ColourCode",
  sizes: "Sizes",
  sizeRange: "SizeRange",
  qtyPerCarton: "QtyPerCarton",
  cartonEan: "CartonEan",
  ean13: "Ean13",
  // The grand total of an assortment matrix: sum(sizeQtyTotal) adds every
  // colour row's total, exactly as {{sizeQtyTotal}} + {{styleNSizeQtyTotal}}
  // would read down the column.
  sizeQtyTotal: "SizeQtyTotal",
};

const AGGREGATE_BY_LOWER = new Map(
  Object.entries(AGGREGATE_FIELDS).map(([key, suffix]) => [key.toLowerCase(), { key, suffix }]),
);

// Canonical base key + sibling suffix for an aggregate field name (written
// case-insensitively), or null when the field can't be aggregated.
export function aggregateField(name: string): { key: string; suffix: string } | null {
  return AGGREGATE_BY_LOWER.get(name.toLowerCase()) ?? null;
}

// First number in a resolved field value — "48" → 48, "29,5" → 29.5,
// "29.00 DKK" → 29. Null when the value carries no number at all.
export function parseNumericValue(raw: string): number | null {
  const m = /-?\d+(?:[.,]\d+)?/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------
// Tokenizer + recursive-descent parser. No eval, no dependencies; parse
// errors are precise strings the builder and the publish gate both show.
// ---------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" | "," };

function tokenize(expr: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      toks.push({ t: "op", v: c as "+" | "-" | "*" | "/" | "(" | ")" | "," });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(?:\.\d+)?/.exec(expr.slice(i))!;
      toks.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const m = /^[a-zA-Z][a-zA-Z0-9]*/.exec(expr.slice(i))!;
      toks.push({ t: "ident", v: m[0] });
      i += m[0].length;
      continue;
    }
    return `unexpected "${c}" in calculation`;
  }
  return toks;
}

export type ParsedCalc = { ast: CalcNode; error?: undefined } | { ast?: undefined; error: string };

export function parseCalcExpression(expr: string): ParsedCalc {
  if (!expr.trim()) return { error: "empty calculation — write e.g. {{= sum(qtyPerCarton) }}" };
  const toks = tokenize(expr);
  if (typeof toks === "string") return { error: toks };

  let pos = 0;
  const peek = () => toks[pos];
  const takeOp = (v: string): boolean => {
    const t = toks[pos];
    if (t?.t === "op" && t.v === v) {
      pos++;
      return true;
    }
    return false;
  };

  function parseExpr(): CalcNode | string {
    let node = parseTerm();
    if (typeof node === "string") return node;
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        pos++;
        const r = parseTerm();
        if (typeof r === "string") return r;
        node = { t: "bin", op: t.v, l: node, r };
        continue;
      }
      return node;
    }
  }

  function parseTerm(): CalcNode | string {
    let node = parseUnary();
    if (typeof node === "string") return node;
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        pos++;
        const r = parseUnary();
        if (typeof r === "string") return r;
        node = { t: "bin", op: t.v, l: node, r };
        continue;
      }
      return node;
    }
  }

  function parseUnary(): CalcNode | string {
    if (takeOp("-")) {
      const inner = parseUnary();
      if (typeof inner === "string") return inner;
      return { t: "bin", op: "-", l: { t: "num", v: 0 }, r: inner };
    }
    return parsePrimary();
  }

  function parsePrimary(): CalcNode | string {
    const t = peek();
    if (!t) return "calculation ends unexpectedly";
    if (t.t === "num") {
      pos++;
      return { t: "num", v: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      pos++;
      const inner = parseExpr();
      if (typeof inner === "string") return inner;
      if (!takeOp(")")) return 'missing ")"';
      return inner;
    }
    if (t.t === "ident") {
      pos++;
      const name = t.v;
      if (!takeOp("(")) return { t: "field", key: name };

      if (name === "round") {
        const inner = parseExpr();
        if (typeof inner === "string") return inner;
        let decimals = 0;
        if (takeOp(",")) {
          const d = peek();
          if (d?.t !== "num" || !Number.isInteger(d.v) || d.v < 0 || d.v > 6) {
            return "round(…, n) needs a whole number of decimals between 0 and 6";
          }
          pos++;
          decimals = d.v;
        }
        if (!takeOp(")")) return 'missing ")" after round(…)';
        return { t: "round", expr: inner, decimals };
      }

      const fnLower = name.toLowerCase();
      const fn = CALC_AGG_FNS.find((f) => f === fnLower);
      if (!fn) return `unknown function "${name}(" — use ${CALC_AGG_FNS.join("/")} or round`;
      const arg = peek();
      if (arg?.t !== "ident") return `${fn}(…) takes a field name, e.g. ${fn}(qtyPerCarton)`;
      pos++;
      if (!takeOp(")")) return `missing ")" after ${fn}(${arg.v}`;
      return { t: "agg", fn, field: arg.v };
    }
    return "unexpected symbol in calculation";
  }

  const ast = parseExpr();
  if (typeof ast === "string") return { error: ast };
  if (pos < toks.length) {
    const t = toks[pos];
    const shown = t.t === "op" ? t.v : t.t === "num" ? String(t.v) : t.v;
    return { error: `unexpected "${shown}" after the expression` };
  }
  return { ast };
}

// ---------------------------------------------------------------------
// Evaluation. The context abstracts WHERE values come from (StyleData on
// the server, mapped columns for readiness previews later): `field`
// returns a directly referenced field's raw string; `aggregate` returns
// the raw value per carton slot — the base style plus the ACTIVE siblings
// only (the caller applies the multi-style gate). Returns the formatted
// string, or null = unresolved (missing base data / bad expression /
// division by zero).
// ---------------------------------------------------------------------

export type CalcFieldCtx = {
  field: (key: string) => string;
  aggregate: (suffix: string) => { base: string; siblings: string[] };
};

function evalNode(node: CalcNode, ctx: CalcFieldCtx): number | null {
  switch (node.t) {
    case "num":
      return node.v;
    case "field": {
      const raw = ctx.field(node.key).trim();
      const sib = parseSiblingTokenKey(node.key);
      const optional = sib !== null && sib.slot >= 2;
      if (raw === "") return optional ? 0 : null;
      const n = parseNumericValue(raw);
      if (n === null) return optional ? 0 : null;
      return n;
    }
    case "agg": {
      const field = aggregateField(node.field);
      if (!field) return null;
      const { base, siblings } = ctx.aggregate(field.suffix);
      if (node.fn === "count") {
        return [base, ...siblings].filter((v) => v.trim() !== "").length;
      }
      // sum/min/max: the base value is REQUIRED (its absence is a data
      // gap on the style being printed); empty or non-numeric sibling
      // slots are simply not on the carton and contribute nothing.
      const baseNum = base.trim() === "" ? null : parseNumericValue(base);
      if (baseNum === null) return null;
      const nums = [baseNum];
      for (const s of siblings) {
        if (s.trim() === "") continue;
        const n = parseNumericValue(s);
        if (n !== null) nums.push(n);
      }
      if (node.fn === "sum") return nums.reduce((a, b) => a + b, 0);
      if (node.fn === "min") return Math.min(...nums);
      return Math.max(...nums);
    }
    case "round": {
      const v = evalNode(node.expr, ctx);
      if (v === null) return null;
      const f = 10 ** node.decimals;
      return Math.round(v * f) / f;
    }
    case "bin": {
      const l = evalNode(node.l, ctx);
      const r = evalNode(node.r, ctx);
      if (l === null || r === null) return null;
      switch (node.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return r === 0 ? null : l / r;
      }
    }
  }
}

// Integers print bare ("84"); fractions print trimmed ("4.5", never
// "4.50") after killing float noise. round(…, n) truncates further via
// its own node — this is only the final presentation.
export function formatCalcResult(n: number): string {
  if (!Number.isFinite(n)) return "";
  const cleaned = Math.round(n * 1e6) / 1e6;
  return String(cleaned);
}

export function evaluateCalc(ast: CalcNode, ctx: CalcFieldCtx): string | null {
  const v = evalNode(ast, ctx);
  if (v === null || !Number.isFinite(v)) return null;
  return formatCalcResult(v);
}

// ---------------------------------------------------------------------
// Line-level helpers, mirroring conditionalsInLine & co.
// ---------------------------------------------------------------------

// Raw expression bodies of every {{= …}} in a line.
export function calcsInLine(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(new RegExp(CALC_RE.source, "g"))) out.push(m[1]);
  return out;
}

// Direct field keys + canonical aggregate base keys an expression reads —
// the readiness/required-columns walk. Parse failures contribute nothing
// (publish validation rejects them separately).
export function fieldsInCalcExpression(expr: string): { fields: string[]; aggregates: string[] } {
  const parsed = parseCalcExpression(expr);
  if (!parsed.ast) return { fields: [], aggregates: [] };
  const fields = new Set<string>();
  const aggregates = new Set<string>();
  const walk = (n: CalcNode) => {
    if (n.t === "field") fields.add(n.key);
    else if (n.t === "agg") {
      const f = aggregateField(n.field);
      if (f) aggregates.add(f.key);
    } else if (n.t === "round") walk(n.expr);
    else if (n.t === "bin") {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(parsed.ast);
  return { fields: [...fields], aggregates: [...aggregates] };
}

// ---------------------------------------------------------------------
// Validation — shared by the builder (live) and the publish gate, like
// validateLineConditionals. Checks syntax, that referenced fields are
// known TEXT tokens usable as numbers, and that aggregate fields are in
// the per-slot projection. Returns [] when clean.
// ---------------------------------------------------------------------

export function validateCalcExpression(expr: string): string[] {
  const parsed = parseCalcExpression(expr);
  if (!parsed.ast) return [`{{= ${expr} }} — ${parsed.error}`];
  const errs: string[] = [];
  const walk = (n: CalcNode) => {
    if (n.t === "field") {
      const meta = tokenMeta(n.key);
      if (!meta) {
        errs.push(`{{= …}} uses unknown field "${n.key}"`);
      } else if (meta.kind !== "text") {
        errs.push(`{{= …}} can only calculate with text fields ("${n.key}" is ${meta.kind})`);
      } else if (meta.arg === "lang") {
        errs.push(`"${n.key}" is a per-language text field — not usable in a calculation`);
      }
    } else if (n.t === "agg") {
      if (!aggregateField(n.field)) {
        errs.push(
          `${n.fn}(${n.field}) — "${n.field}" can't be aggregated across styles; use one of: ${Object.keys(AGGREGATE_FIELDS).join(", ")}`,
        );
      }
    } else if (n.t === "round") {
      walk(n.expr);
    } else if (n.t === "bin") {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(parsed.ast);
  return errs;
}

// Per-line validation: every complete {{= …}} validated, plus any "{{="
// left over after consuming complete ones is an unclosed calc.
export function validateLineCalcs(line: string): string[] {
  const errs: string[] = [];
  for (const expr of calcsInLine(line)) errs.push(...validateCalcExpression(expr));
  const consumed = line.replace(new RegExp(CALC_RE.source, "g"), "");
  if (consumed.includes("{{=")) {
    errs.push('unclosed calculated field — "{{=" without a matching "}}"');
  }
  return errs;
}
