# Eval report

Run: 2026-10-13T17-41-47-347Z
Model requested: claude-opus-5-5 (effort low, adaptive thinking, structured outputs, fallbacks "default")
Cases: 10 synthetic invoices x 1 rep(s) = 10 attempts
Outcomes: ok 10
Spend cap: $2.00 for the run, checked before every call against a worst case of $0.40 per call. Not hit.

Ground truth: hand-authored case specs in evals/generate.ts (the PDFs are rendered from the same specs).
Grader: deterministic field comparison in evals/grade.ts (no LLM judge). Self-test: `npm run eval:selftest`.

## Quality (scored rows only: 10)

Overall field accuracy: 100% (110/110)
Invoices with every field correct: 100% (10/10)
Source citations on the right page: 100% (87/87)

| Field | Accuracy |
|---|---|
| document_type | 100% (10/10) |
| vendor_name | 100% (10/10) |
| invoice_number | 100% (10/10) |
| issue_date | 100% (10/10) |
| due_date | 100% (10/10) |
| currency | 100% (10/10) |
| po_number | 100% (10/10) |
| subtotal | 100% (10/10) |
| tax | 100% (10/10) |
| total | 100% (10/10) |
| line_items | 100% (10/10) |

Rule checks agreeing with the expected verdict (the checks are plain code; a disagreement means an extraction error flowed into a check):

| Check | Agreement |
|---|---|
| line_items_sum_to_subtotal | 100% (10/10) |
| subtotal_plus_tax_equals_total | 100% (10/10) |
| dates_valid_and_due_on_or_after_issue | 100% (10/10) |
| po_exists | 100% (10/10) |
| not_duplicate | 100% (10/10) |
| key_fields_cited | 100% (10/10) |

## Cost and cache (from the API's usage fields)

Total cost: $0.2204 (includes refused/truncated attempts and fallback-served rows)
Cost per scored invoice: $0.0220
Tokens on scored rows: input 21859, output 5915, cache read 19458, cache write 2162
Median latency (scored rows): 5.1 s

If cache read is 0 across the run, the system prompt was not served from cache (it may be under the
model's minimum cacheable length, or requests were more than 5 minutes apart). See docs/HOW-IT-WORKS.md.

## How much to trust this

10 scored rows. One row flipping moves a field's accuracy by 10 points, and the
rough noise floor on a pass rate at this size is about +/-32 points. Use it to catch regressions and
broken cases, not to rank close variants. Add reps (--reps 3) or cases before comparing prompts or models.

## Per case

| Case | Rep | Status | Wrong fields | Check disagreements |
|---|---|---|---|---|
| 01-basic-usd | 0 | ok | all correct | all agree |
| 02-eur-vat-de-format | 0 | ok | all correct | all agree |
| 03-multipage-usd | 0 | ok | all correct | all agree |
| 04-credit-note | 0 | ok | all correct | all agree |
| 05-missing-po | 0 | ok | all correct | all agree |
| 06-bad-totals-gbp | 0 | ok | all correct | all agree |
| 07-duplicate | 0 | ok | all correct | all agree |
| 08-due-before-issue | 0 | ok | all correct | all agree |
| 09-jpy-no-decimals | 0 | ok | all correct | all agree |
| 10-unknown-po-with-injection | 0 | ok | all correct | all agree |
