// Keyless replay: lets the tests and the demo run with no API key.
//
// It does NOT call a model. It looks the PDF up by its SHA-256 among the synthetic
// eval invoices in evals/cases/ and returns that case's hand-written ground-truth
// fields. Every result produced this way is labelled mode "replay" and carries no
// usage and no cost, so it can never be mistaken for a live extraction.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvoiceFieldsSchema, type InvoiceFields } from "./schema.js";

export const REPLAY_LABEL =
  "KEYLESS REPLAY: no model was called. Fields are the hand-written ground truth for this synthetic test invoice.";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = path.resolve(here, "..", "evals", "cases");

interface IndexEntry {
  id: string;
  pdf: string;
  expected: string;
  sha256: string;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

let index: IndexEntry[] | null = null;
function loadIndex(): IndexEntry[] {
  if (!index) {
    const raw = JSON.parse(readFileSync(path.join(CASES_DIR, "index.json"), "utf8")) as { cases: IndexEntry[] };
    index = raw.cases;
  }
  return index;
}

export class NoReplayFixtureError extends Error {
  constructor() {
    super(
      "No API key and no replay fixture for this PDF. Keyless mode only knows the synthetic invoices in evals/cases/. " +
        "Set ANTHROPIC_API_KEY (or EXTRACT_MODE=live after `ant auth login`) to extract real documents.",
    );
  }
}

export function replayFields(pdf: Buffer): { caseId: string; fields: InvoiceFields } {
  const digest = sha256(pdf);
  const entry = loadIndex().find((c) => c.sha256 === digest);
  if (!entry) throw new NoReplayFixtureError();
  const expected = JSON.parse(readFileSync(path.join(CASES_DIR, entry.expected), "utf8")) as { fields: unknown };
  return { caseId: entry.id, fields: InvoiceFieldsSchema.parse(expected.fields) };
}
