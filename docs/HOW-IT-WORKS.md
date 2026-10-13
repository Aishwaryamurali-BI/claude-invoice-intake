# How it works: a study guide

This guide walks through the repo file by file and explains why each choice was made. Read it with the code open beside it.

## The flow in one paragraph

An invoice PDF arrives (IMAP email or webhook) in n8n. n8n base64-encodes it and calls the MCP server's `extract_invoice` tool over HTTP with a **read-only** token. The server sends the PDF to Claude, gets back JSON that matches a fixed schema, runs six rule checks in plain code, and saves the invoice as `pending_approval`. Nothing is filed yet. If every check passed, n8n DMs the approver in Slack with Approve/Reject buttons and waits. On Approve, n8n calls `approve_invoice` with an **approver** token and the approver's name; only then does the server copy the invoice into `data/filed/`. If a check failed, the invoice goes to a review channel instead, and a person can still approve it later, but only by giving an override reason.

---

## File by file

### `src/schema.ts`: what we ask Claude for

One zod schema describes the answer: document type, vendor, invoice number, dates, currency, PO, line items, subtotal, tax, total, and a `sources` list (field, page, quote).

- The same schema is sent to the API as the structured-output format **and** used to validate the reply. One definition, so the prompt and the code can't drift apart.
- Amounts are "as printed". If the vendor's numbers are wrong, we want to see the wrong numbers, not have the model quietly fix them.
- Something found while testing: the SDK's zod helper (`betaZodOutputFormat`) moves `enum` lists into the field description instead of sending them as JSON-schema enums. So the API only *hints* that `document_type` is `invoice` or `credit_note`; the zod parse afterwards is what enforces it. `tests/wire.test.ts` captures the real request, which is how this was found.

### `src/extract.ts`: the Claude call

`buildRequest()` builds one request:

| Setting | Value | Why |
|---|---|---|
| `model` | `claude-opus-5-5` | Current Opus. |
| `output_config.effort` | `low` | Copying fields off a page is not a reasoning task. On Opus 5.5 thinking can't be turned off (sending `thinking: {type: "disabled"}` is a 400), so effort is the control. Low keeps thinking short, which saves output tokens and time. |
| `thinking` | omitted | Omitted means adaptive, which is the default and the only option on this model. |
| `output_config.format` | the zod schema | Structured outputs: the reply is guaranteed to be valid JSON in this shape (unless it was cut off or refused). |
| `system` + `cache_control` | fixed prompt, cached | See "Prompt caching" below. |
| PDF | base64 `document` block | The PDF goes in as-is; Claude reads both the text and the page images. |
| `fallbacks: "default"` + beta `server-side-fallback-2026-07-01` | | If Opus 5.5's safety classifiers decline the request, the API re-runs it on Anthropic's recommended fallback model inside the same call. |
| `max_tokens` | 16000 | Thinking counts toward `max_tokens`, so it needs headroom. |

Then `extractInvoice()`:

1. **Checks `stop_reason` before touching the content.** `refusal`: throw `ExtractionRefusedError` (with the category, and the cost so far). `max_tokens`: throw `ExtractionTruncatedError`, because half a JSON object is useless.
2. Only then parses the text with the schema.
3. Runs the checks and computes the cost.

Why `messages.create` and not `messages.parse`? `parse` would be shorter, but it parses inside the SDK and throws on an incomplete reply before you can see `stop_reason` or `usage`. Calling `create`, checking `stop_reason`, then parsing with the same helper gives the same validation plus a clear reason and a cost line on every failure.

If a fallback model answered, the result is labelled `LIVE: requested claude-opus-5-5, served by fallback model ...`, and each attempt is priced at its own model's rates.

### `src/checks.ts`: rules, not AI

Six checks, each returning pass/fail and a sentence:

1. `line_items_sum_to_subtotal` (to the cent)
2. `subtotal_plus_tax_equals_total`
3. `dates_valid_and_due_on_or_after_issue` (real calendar dates; due may equal issue, which covers "due on receipt"; a credit note may have no due date)
4. `po_exists` (in the open-PO list; credit notes don't need one)
5. `not_duplicate` (same vendor + invoice number already pending or filed; vendor names compared without case or punctuation)
6. `key_fields_cited` (every non-null key field has a page and quote; for invoice and PO numbers the quote must actually contain the value)

**Why rules and not Claude for this?** Addition and lookups are exact problems. Code gets them right every time, costs nothing, gives the same answer twice, and can be unit tested (`tests/checks.test.ts`). A model checking arithmetic is slower, costs tokens, can be confidently wrong, and can't be audited the same way. The split is: the model does the part that needs reading (finding the numbers on a messy page), code does the part that needs exactness (checking them).

### `src/cost.ts`: the cost line

Cost comes from the token counts the API returns, never from estimates:

- `input_tokens`: uncached input, $4 per million on Opus 5.5
- `output_tokens` (includes thinking): $20 per million
- `cache_read_input_tokens`: $0.20 per million
- cache writes: 1.25x the input price for the 5-minute cache, 2x for the 1-hour cache

`input_tokens` is only the **uncached** part. The real prompt size is input + cache read + cache write. A common mistake is pricing only `input_tokens`.

When a fallback happens, `usage.iterations` lists each attempt with its model, and each is priced at that model's rate. An unknown model throws instead of guessing.

### `src/replay.ts`: keyless mode

So the tests and demo run without a key. It hashes the PDF, finds it among the synthetic eval invoices, and returns that invoice's ground truth. It is always labelled `KEYLESS REPLAY: no model was called`, with `usage: null` and `costUsd: null`. Any other PDF is refused. The eval refuses to run in this mode, because scoring the answer key against itself would produce a fake 100%.

### `src/store.ts`: the approval gate

SQLite (`better-sqlite3`) for records, folders for PDFs:

- `stage()` writes the PDF to `data/inbox/` and a `pending_approval` row. It is the only thing `extract_invoice` does to storage.
- `approve()` is the **only** code that writes to `data/filed/`. It refuses a blank approver, refuses an invoice that's already decided, and refuses an invoice with failed checks unless there's an `override_reason`.
- `reject()` records who and why, and files nothing.
- Each decision stores `decided_by` (the human) and `decided_via` (which token made the call), so an audit can tell "Sam approved, relayed by n8n" from "Aishu approved from Claude Code".

### `src/forecast.ts`: weekly payables

Groups invoices by due date into an overdue bucket plus N weeks (default 4). Approved invoices are "committed"; pending ones are shown separately, because nobody has said yes yet. Credit notes subtract. Rejected invoices are ignored. Amounts stay in their own currencies: converting them would need an exchange rate, and a made-up rate would be a made-up number.

### `src/auth.ts`: tokens and scopes

- Tokens come from environment variables as `name=token` pairs: `READ_TOKENS` (scope `read`) and `APPROVER_TOKENS` (scopes `read` + `approve`). Startup fails if a token is under 32 characters or two principals share a name or token.
- **Constant-time compare:** both the presented token and each stored token are SHA-256 hashed, then compared with `crypto.timingSafeEqual`, and the loop checks every entry without stopping early. A plain `===` can return faster when the first characters differ, which in theory lets an attacker guess a token byte by byte from response times.
- Tokens are never logged, never put in error messages and never returned by a tool.
- `checkApprover()`: a person's own token can only approve **as that person**. A service token listed in `RELAY_PRINCIPALS` (n8n) may name any human on the `APPROVERS` list, because it is relaying a Slack click. That is a trust decision: whoever holds the n8n approver token could approve without a click, which is why that token lives only in the two decision nodes. An approver token that is on neither list fails at startup, so a name left off `APPROVERS` can never approve as someone else by accident.

### `src/mcp-server.ts`: the MCP server

- Built on the official `@modelcontextprotocol/sdk` (v1.x line): `McpServer.registerTool` with zod input schemas, `StreamableHTTPServerTransport` in **stateless** mode (`sessionIdGenerator: undefined`) with `enableJsonResponse: true`.
- **Per-request server, per-token tools.** Each POST authenticates the bearer token first (before the body is even parsed), then builds a fresh `McpServer` with only the tools that token may use. A read token's `tools/list` has no approve or reject tools at all, so neither a model nor a script holding that token can call them. The write handlers check the scope again anyway (defence in depth; `tests/` proves both layers).
- Host-header validation (from the SDK) blocks DNS-rebinding attacks against a server on localhost.
- Tool annotations (`readOnlyHint` and so on) are set honestly. `extract_invoice` is *not* read-only: it stages a record. It doesn't file or send anything, which is why a read-scope token may call it.
- Audit log: one JSON line per tool call with the principal, tool and outcome. No arguments, no invoice contents, no tokens.

**Why stateless + JSON?** n8n doesn't need a session or a stream. Stateless means any request can hit any server instance, and JSON responses mean a plain HTTP Request node can call a tool with one POST. The cost is no server-to-client notifications, which this server doesn't use.

### `n8n/invoice-intake.json`

| Node | What it does |
|---|---|
| New invoice email (IMAP) / Invoice upload (webhook) | Two ways in. The webhook uses header auth. |
| Pick PDF attachments | Code: every PDF attachment becomes `{pdf_base64, source_name}`; other files are ignored. |
| Config | One place for the MCP URL, approver name, approver's Slack ID and review channel. |
| Extract invoice (MCP, read token) | HTTP POST of a JSON-RPC `tools/call`. **Retry on fail: 3 tries, 5 s apart.** Its red error output goes to a Slack alert. |
| Read MCP result | Unwraps the JSON-RPC reply. If the tool reported an error (refusal, truncation), it throws on purpose so the Error workflow alerts someone. |
| All checks passed? | Yes: ask the approver. No: post to the review channel. |
| Ask approver in Slack (wait) | Slack "send and wait for response" as a DM to one approver, with the fields, the sources and the extraction cost. Times out after 3 days. |
| Approved? / Rejected? | Two IFs, so a timeout (neither true nor false) does nothing. The invoice stays pending and shows up in `list_pending_approvals`. A timeout must never count as a rejection, and certainly not as an approval. |
| approve_invoice / reject_invoice (approver token) | The only nodes holding the approver credential. |
| Confirm decision saved | The HTTP call can succeed while the tool says no (already decided, approver not allowed). This throws so it isn't missed. |

Settings: `errorWorkflow` points at `n8n/error-alert.json`, an **Error Trigger** workflow that posts the failed node and execution link to Slack, without invoice contents. `saveDataSuccessExecution: none` keeps successful runs (which contain PDFs) out of n8n's database.

**Retries and idempotency.** Retrying `extract_invoice` after a timeout could stage the same invoice twice; the duplicate check flags the second copy, so a person sees it rather than paying twice. Retrying `approve_invoice` after a lost response returns "already approved" and files nothing twice.

### `evals/`

- `generate.ts` writes 10 synthetic PDFs (pdfkit, fixed creation date so the bytes are reproducible) and their ground truth from one table of hand-written case specs. Each case also says which checks it expects to fail, and the script stops if the rules disagree.
- `grade.ts` compares field by field with fixed rules (vendor names ignore case and punctuation, money to the cent, line items by count and amounts). No LLM judge, so grading is deterministic and free.
- `run.ts` follows the eval-health checklist: it calls the same `extractInvoice` the server uses (not a copy); refusals and truncations are recorded as their own outcomes, not as wrong answers; API and network failures go to `errors.jsonl`, never into scores; it retries 429/5xx with jittered backoff and records the attempt count; a fallback-served row isn't scored as Opus 5.5; every row saves its full output; and the report states the noise floor (with 10 cases, one flip moves a field by 10 points).
- `npm run eval:selftest` runs the ground truth through the grader (must score 100%) and an empty extraction (must fail). It catches a broken grader before you pay for a run.

---

## Prompt caching, and whether it hits

Caching works by **prefix**: the API reuses work for the exact same bytes at the start of a request, up to a `cache_control` marker. Order is tools, then system, then messages.

Here the marker is on the system prompt, which is the same for every invoice. The PDF comes after it in the user message and is different every time, so it can't be cached.

Reasons it might still not hit:

1. **Too short.** Opus 5.5 won't cache a prefix under 512 tokens, and it fails silently (`cache_creation_input_tokens: 0`, no error). The system prompt is about 2,500 characters, which looked close to the line. The 2026-10-13 live run settled it: the first call wrote 2,162 tokens to the cache and the next nine calls read them back (`evals/reports/2026-10-13-opus-5-5/results.jsonl`).
2. **Expired.** The default cache lives 5 minutes from the last use. Invoices arriving an hour apart will each pay a cache write and never read it back.
3. **Something changed the prefix.** A timestamp or ID in the system prompt misses every time. Switching models (including a fallback) misses, and changing the effort setting can too. `tests/extract.test.ts` checks that the system prompt has no dates or IDs in it.
4. **Different workspace.** Caches are per workspace.

Be honest about the size of the win: even when it hits, it only saves the system prompt's tokens. The PDF is most of the input. Caching matters more for large shared context (a long policy document, a vendor master list). The eval report shows the real cache-read tokens so you can see whether it worked instead of assuming.

## Structured outputs vs tool use

Both can force JSON. **Structured outputs** (`output_config.format`) constrain the reply itself to the schema; it's the direct way to say "answer in this shape". **Tool use** is for when the model should *decide* to call something. Faking extraction as a tool call used to be the trick, but on Opus 5.5 forcing a specific tool (`tool_choice: {type: "tool"}`) returns a 400, so the tool route would be optional anyway.

Why not the Citations feature for the sources? Citations can't be combined with structured outputs (the API returns a 400). So the schema asks for page + verbatim quote, and `key_fields_cited` checks them in code.

## MCP auth and least privilege

- Each person or service gets its own token, so every action is attributable.
- Scopes decide which tools exist for that caller, not just which ones are allowed.
- The Claude client stores the token in its connector config (`claude mcp add ... --header`). The model sees tool names, inputs and results, never the header.
- The Anthropic API key sits only in the MCP server's environment. n8n never has it, and nothing in n8n can call Claude directly.
