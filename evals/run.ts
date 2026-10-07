// Eval runner.
//
//   npm run eval                       live run against the 10 synthetic invoices (needs a key)
//   npm run eval -- --reps 3           three repetitions per case
//   npm run eval -- --cases 03-multipage-usd,09-jpy-no-decimals
//   npm run eval:selftest              keyless: checks the grader itself (oracle + null baseline)
//
// Live runs write evals/runs/<timestamp>/{results.jsonl,errors.jsonl,report.md}.
// Without credentials it exits with a message and writes nothing. It never falls back
// to the replay fixtures: replay returns the ground truth, so scoring it would be fake.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runChecks, CHECK_NAMES } from "../src/checks.js";
import {
  defaultMode,
  extractInvoice,
  ExtractionParseError,
  ExtractionRefusedError,
  ExtractionTruncatedError,
  isRequestedModel,
  MODEL,
  type ExtractResult,
} from "../src/extract.js";
import type { InvoiceFields } from "../src/schema.js";
import { grade, nullFields, GRADED_FIELDS, type Grade } from "./grade.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(here, "cases");

interface Expected {
  id: string;
  description: string;
  tags: string[];
  context: { knownInvoices: { vendor_name: string; invoice_number: string }[]; purchaseOrders: string[] };
  fields: InvoiceFields;
  expected_checks: Record<string, boolean>;
}

function loadCases(filter?: string[]): { expected: Expected; pdf: Buffer }[] {
  const index = JSON.parse(readFileSync(path.join(CASES_DIR, "index.json"), "utf8")) as { cases: { id: string; pdf: string; expected: string }[] };
  return index.cases
    .filter((c) => !filter || filter.includes(c.id))
    .map((c) => ({
      expected: JSON.parse(readFileSync(path.join(CASES_DIR, c.expected), "utf8")) as Expected,
      pdf: readFileSync(path.join(CASES_DIR, c.pdf)),
    }));
}

// ---------- aggregation (shared by live run and self-test) ----------

interface ScoredRow {
  case: string;
  rep: number;
  grade: Grade;
}

function summarize(rows: ScoredRow[]) {
  const n = rows.length;
  const pct = (k: number, d: number) => (d === 0 ? "n/a" : `${((100 * k) / d).toFixed(0)}% (${k}/${d})`);
  const fieldAcc = Object.fromEntries(GRADED_FIELDS.map((f) => [f, pct(rows.filter((r) => r.grade.fields[f]).length, n)]));
  const checkAcc = Object.fromEntries(CHECK_NAMES.map((c) => [c, pct(rows.filter((r) => r.grade.checks[c]).length, n)]));
  const allFieldCells = rows.flatMap((r) => Object.values(r.grade.fields));
  const pageCells = rows.flatMap((r) => Object.values(r.grade.sourcePages));
  return {
    n,
    fieldAcc,
    checkAcc,
    overallField: pct(allFieldCells.filter(Boolean).length, allFieldCells.length),
    casesAllCorrect: pct(rows.filter((r) => r.grade.allFieldsCorrect).length, n),
    sourcePageAcc: pct(pageCells.filter(Boolean).length, pageCells.length),
    overallFieldRatio: allFieldCells.length ? allFieldCells.filter(Boolean).length / allFieldCells.length : 0,
  };
}

// ---------- self-test: is the grader wired correctly? ----------

function selftest() {
  console.log("GRADER SELF-TEST (no model is called; these are not model results)\n");
  const cases = loadCases();
  const oracle: ScoredRow[] = cases.map(({ expected }) => {
    const checks = runChecks(expected.fields, expected.context);
    return { case: expected.id, rep: 0, grade: grade(expected, expected.fields, checks) };
  });
  const nul: ScoredRow[] = cases.map(({ expected }) => {
    const f = nullFields();
    return { case: expected.id, rep: 0, grade: grade(expected, f, runChecks(f, expected.context)) };
  });
  const so = summarize(oracle);
  const sn = summarize(nul);
  console.log(`Oracle (ground truth graded against itself): field accuracy ${so.overallField}, cases all-correct ${so.casesAllCorrect}`);
  console.log(`Null baseline (empty extraction):            field accuracy ${sn.overallField}, cases all-correct ${sn.casesAllCorrect}`);
  const okOracle = so.overallFieldRatio === 1 && oracle.every((r) => Object.values(r.grade.checks).every(Boolean));
  const okNull = sn.overallFieldRatio < 0.35 && nul.every((r) => !r.grade.allFieldsCorrect);
  console.log(okOracle && okNull ? "\nPASS: oracle scores 100%, null baseline fails." : "\nFAIL: grader is miswired.");
  process.exit(okOracle && okNull ? 0 : 1);
}

// ---------- live run ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (err instanceof Anthropic.APIError) return err.status === 429 || (err.status !== undefined && err.status >= 500);
  return false;
}

async function withRetries<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<{ value: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(), attempts: attempt };
    } catch (err) {
      if (!isTransient(err) || attempt >= maxAttempts) throw Object.assign(err as object, { attempts: attempt });
      const base = 2000 * 2 ** (attempt - 1);
      await sleep(base / 2 + Math.random() * base); // jittered exponential backoff
    }
  }
}

async function live(opts: { reps: number; filter?: string[] }) {
  if (defaultMode() !== "live") {
    console.error(
      "npm run eval needs Claude API credentials and makes paid calls.\n" +
        "  - set ANTHROPIC_API_KEY, or\n" +
        "  - run `ant auth login` and then EXTRACT_MODE=live npm run eval\n" +
        "Nothing was run and no numbers were written. (To check the grader without a key: npm run eval:selftest)",
    );
    process.exit(2);
  }
  const cases = loadCases(opts.filter);
  const client = new Anthropic();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(here, "runs", stamp);
  mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, "results.jsonl");
  const errorsFile = path.join(outDir, "errors.jsonl");
  writeFileSync(resultsFile, "");
  writeFileSync(errorsFile, "");

  const scored: ScoredRow[] = [];
  const statusCounts: Record<string, number> = {};
  let totalCost = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let inputTok = 0;
  let outputTok = 0;
  const latencies: number[] = [];
  const perCase: string[] = [];

  for (const { expected, pdf } of cases) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const tag = `${expected.id} rep ${rep}`;
      let res: ExtractResult;
      let attempts = 1;
      try {
        const r = await withRetries(() =>
          extractInvoice(pdf, { mode: "live", client, context: expected.context, maxRetries: 0, timeoutMs: 180_000 }),
        );
        res = r.value;
        attempts = r.attempts;
      } catch (err) {
        const e = err as Error & { attempts?: number; costUsd?: number };
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          console.error(`Authentication failed (${e.message}). Stopping; no report written.`);
          process.exit(2);
        }
        const status =
          err instanceof ExtractionRefusedError ? "refused" : err instanceof ExtractionTruncatedError ? "truncated" : err instanceof ExtractionParseError ? "parse_error" : null;
        if (status) {
          // Model outcomes: recorded and counted, but not averaged into field accuracy.
          statusCounts[status] = (statusCounts[status] ?? 0) + 1;
          totalCost += e.costUsd ?? 0;
          appendFileSync(resultsFile, JSON.stringify({ case: expected.id, rep, status, error: e.message, cost_usd: e.costUsd ?? null, attempts: e.attempts ?? 1 }) + "\n");
          perCase.push(`| ${expected.id} | ${rep} | ${status} | - | - |`);
        } else {
          // Infrastructure failures never land in results.jsonl.
          statusCounts.infra_error = (statusCounts.infra_error ?? 0) + 1;
          appendFileSync(errorsFile, JSON.stringify({ case: expected.id, rep, class: "harness/serving error", error: e.message, attempts: e.attempts ?? 1 }) + "\n");
          perCase.push(`| ${expected.id} | ${rep} | infra error | - | - |`);
        }
        console.log(`${tag}: ${status ?? "infra error"}`);
        continue;
      }

      totalCost += res.costUsd ?? 0;
      if (res.fallbackUsed || !isRequestedModel(res.servedModel)) {
        // Served by a different model than the one under test: don't score it.
        statusCounts.served_model_mismatch = (statusCounts.served_model_mismatch ?? 0) + 1;
        appendFileSync(errorsFile, JSON.stringify({ case: expected.id, rep, class: "served-model mismatch", served_model: res.servedModel, cost_usd: res.costUsd }) + "\n");
        perCase.push(`| ${expected.id} | ${rep} | served by ${res.servedModel} (not scored) | - | - |`);
        continue;
      }
      const g = grade(expected, res.fields, res.checks);
      scored.push({ case: expected.id, rep, grade: g });
      statusCounts.ok = (statusCounts.ok ?? 0) + 1;
      cacheRead += res.usage!.cache_read_input_tokens;
      cacheWrite += res.usage!.cache_creation_input_tokens;
      inputTok += res.usage!.input_tokens;
      outputTok += res.usage!.output_tokens;
      latencies.push(res.latencyMs!);
      appendFileSync(
        resultsFile,
        JSON.stringify({
          case: expected.id,
          rep,
          status: "ok",
          attempts,
          stop_reason: res.stopReason,
          served_model: res.servedModel,
          request_id: res.requestId,
          latency_ms: Math.round(res.latencyMs!),
          usage: res.usage,
          cost_usd: res.costUsd,
          grade: g,
          fields: res.fields,
          checks: res.checks,
        }) + "\n",
      );
      const wrong = Object.entries(g.fields).filter(([, v]) => !v).map(([k]) => k);
      const checkMiss = Object.entries(g.checks).filter(([, v]) => !v).map(([k]) => k);
      perCase.push(`| ${expected.id} | ${rep} | ok | ${wrong.join(", ") || "all correct"} | ${checkMiss.join(", ") || "all agree"} |`);
      console.log(`${tag}: ${wrong.length === 0 ? "all fields correct" : "wrong: " + wrong.join(", ")}  $${res.costUsd!.toFixed(4)}`);
    }
  }

  const s = summarize(scored);
  const attempted = cases.length * opts.reps;
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  const noise = s.n ? (100 / Math.sqrt(s.n)).toFixed(0) : "n/a";
  const report = `# Eval report

Run: ${stamp}
Model requested: ${MODEL} (effort low, adaptive thinking, structured outputs, fallbacks "default")
Cases: ${cases.length} synthetic invoices x ${opts.reps} rep(s) = ${attempted} attempts
Outcomes: ${Object.entries(statusCounts).map(([k, v]) => `${k} ${v}`).join(", ")}

Ground truth: hand-authored case specs in evals/generate.ts (the PDFs are rendered from the same specs).
Grader: deterministic field comparison in evals/grade.ts (no LLM judge). Self-test: \`npm run eval:selftest\`.

## Quality (scored rows only: ${s.n})

Overall field accuracy: ${s.overallField}
Invoices with every field correct: ${s.casesAllCorrect}
Source citations on the right page: ${s.sourcePageAcc}

| Field | Accuracy |
|---|---|
${GRADED_FIELDS.map((f) => `| ${f} | ${s.fieldAcc[f]} |`).join("\n")}

Rule checks agreeing with the expected verdict (the checks are plain code; a disagreement means an extraction error flowed into a check):

| Check | Agreement |
|---|---|
${CHECK_NAMES.map((c) => `| ${c} | ${s.checkAcc[c]} |`).join("\n")}

## Cost and cache (from the API's usage fields)

Total cost: $${totalCost.toFixed(4)} (includes refused/truncated attempts and fallback-served rows)
Cost per scored invoice: ${s.n ? "$" + (scoredCost(resultsFile) / s.n).toFixed(4) : "n/a"}
Tokens on scored rows: input ${inputTok}, output ${outputTok}, cache read ${cacheRead}, cache write ${cacheWrite}
Median latency (scored rows): ${median !== null ? (median / 1000).toFixed(1) + " s" : "n/a"}

If cache read is 0 across the run, the system prompt was not served from cache (it may be under the
model's minimum cacheable length, or requests were more than 5 minutes apart). See docs/HOW-IT-WORKS.md.

## How much to trust this

${s.n} scored rows. One row flipping moves a field's accuracy by ${s.n ? (100 / s.n).toFixed(0) : "n/a"} points, and the
rough noise floor on a pass rate at this size is about +/-${noise} points. Use it to catch regressions and
broken cases, not to rank close variants. Add reps (--reps 3) or cases before comparing prompts or models.

## Per case

| Case | Rep | Status | Wrong fields | Check disagreements |
|---|---|---|---|---|
${perCase.join("\n")}
`;
  writeFileSync(path.join(outDir, "report.md"), report);
  console.log(`\nReport: ${path.relative(process.cwd(), path.join(outDir, "report.md"))}`);
}

function scoredCost(resultsFile: string): number {
  return readFileSync(resultsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { status: string; cost_usd: number | null })
    .filter((r) => r.status === "ok")
    .reduce((a, r) => a + (r.cost_usd ?? 0), 0);
}

const { values } = parseArgs({
  options: {
    reps: { type: "string", default: "1" },
    cases: { type: "string" },
    selftest: { type: "boolean", default: false },
  },
});

if (values.selftest) selftest();
else await live({ reps: Math.max(1, Number(values.reps)), filter: values.cases?.split(",") });
