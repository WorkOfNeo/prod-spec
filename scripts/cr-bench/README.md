# Change-request test bench

Replays change requests against the real model, offline, and scores what the agent hands back. It needs **only an API key**: no database, no `.env`.

```sh
ANTHROPIC_API_KEY=sk-ant-… npx tsx scripts/cr-bench.ts                      # every case
ANTHROPIC_API_KEY=sk-ant-… npx tsx scripts/cr-bench.ts --case polybag-qty   # one case (repeat or a,b)
ANTHROPIC_API_KEY=sk-ant-… npx tsx scripts/cr-bench.ts --model <id>         # another model
ANTHROPIC_API_KEY=sk-ant-… npx tsx scripts/cr-bench.ts --out run.json       # default /tmp/cr-bench-<timestamp>.json
ANTHROPIC_API_KEY=sk-ant-… npx tsx scripts/cr-bench.ts --no-images          # text-only proofs
npx tsx scripts/cr-bench.ts --score run.json [--out rescored.json]          # re-score saved outcomes, no API call
```

`CHANGE_REQUEST_EFFORT` and `CHANGE_REQUEST_TASK_BUDGET` apply as in the app. For proof pictures, set `PUPPETEER_EXECUTABLE_PATH` to a Chromium binary (or have Puppeteer's own browser installed). Without a browser, `render_proof` sends a text reading of the proof and tells the agent the pictures are unavailable.

## What runs

Each case goes through the production pieces: the default system prompt (`agent/prompt.ts`, without admin edits or memory notes), the production first message (`buildFirstMessage` in `agent/job.ts`), the production loop (`runAgentLoop`) with the production client, effort and call budget. Only the tools are swapped: `src/lib/change-requests/bench/fixture-tools.ts` serves all 12 agent tools from the case file. Drafts stay in memory, and hand-offs are recorded, never sent. The renderer's database reads are answered by an empty stand-in (`bench/offline-db.ts`), so wash symbols render as placeholder squares.

Per case it prints the tool calls and turns as they happen, then a table (case, verdict, placement, warnings, score, cost), and writes a JSON file with the full outcome (every draft, the hand-off, the score notes, tokens and cost).

## Scoring

`src/lib/change-requests/bench/score.ts` has the weights at the top. In short:

| Expected | Components (points) |
|---|---|
| patch | verdict 40 · tokens 20 · placement 25 · control 15 |
| gap | verdict 60 · gap token key 40 |
| question | verdict 100 |

A component the case doesn't ask for is dropped and the rest scaled up to 100. Each warning on the handed-over draft costs 2 points, up to 10. Verdict: `finish` with a draft = patch, `declare_gap` = gap, `ask_reviewer` = question. Placement distance is `|Δcol| + |Δrow| + |ΔcolSpan| + |ΔrowSpan|` in grid cells. The control check renders every style with the live layout and with the final draft, and compares what prints.

A gap's token key matches when it equals the expected key or contains its last camel-case word. For `polybagQty`, any key with "qty" in it counts.

## Adding a case from a real request

The repo is **public**. A case must not carry anything that identifies a customer or an order.

1. **Copy the closest case** in `cases/` to `cases/<new-id>.json`. Set `id` to the file name (lowercase, digits, hyphens).
2. **Request.** Paste the message and the issue text for the one output this case is about (`request.outputLabel`, `request.text`). Then strip it: customer and brand names, people's names, email addresses, PO and order numbers, article numbers, file names. Use neutral stand-ins such as "Sample Retailer", `PO-0001` or `880101`. Keep the wording otherwise. How people phrase requests is what the bench tests.
3. **Layout.** In the Output Builder, copy the layout's definition JSON into `layout.definition`. Give it a synthetic `id` and `name`. Remove anything customer-specific from fixed text lines. If the request was about something that has since been fixed, revert the layout to how it was **before** the fix. Blocks without an `id` get one when the case loads (`b-r<index>`).
4. **Styles.** Add 2–4 styles: at least one the request is about (`"group": "changed"`) and one it must leave alone (`"group": "control"`). The first `changed` style is the request's representative style. `values` are **StyleData overrides on top of the sample data**, set the way Monday fills them. For example, `"trimsRaw": "Solid polybag- 5 Pcs / Polybag"` lets the production resolver derive `{{polybagQty}}`. Keys are listed at the top of `bench/case-schema.ts`, and an unknown key fails the load. Use made-up values. EANs must be restricted-circulation numbers (prefix `2`, valid check digit) and never real product codes.
5. **Screenshots** (optional). Add `images: ["<file>.png"]` next to the case file. Only use pictures of the synthetic case itself, never the customer's screenshot. You can render one from the bench's own proof.
6. **Expected.** Fill in `verdict` and what a right answer looks like:
   - `tokensUsed`: tokens the change must use. `"a|b"` accepts either.
   - `block`: where the new or changed block belongs (`page`, `rect`, `tolerance` in cells, `lineIncludes` substrings). Take it from the fix that was actually approved.
   - `mustNotChangeStyleIds`: the control styles.
   - `gapTokenKey` for a gap case. To ask "would the agent stop and hand over?", list the token that solved it in `removeTokens`. It is then hidden from `list_tokens`, refused by `propose_patch` and accepted by `declare_gap`.
7. **Check it.** Run `node --import tsx --test src/lib/change-requests/bench/*.test.ts`. The schema test loads every case and checks that EANs and PO numbers are placeholders. Then run the case against the model.
