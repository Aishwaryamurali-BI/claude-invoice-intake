// Grader: compares one extraction with the ground truth. Deterministic, no LLM judge.
import { vendorKey, type CheckName, type CheckResult } from "../src/checks.js";
import { KEY_FIELDS, type InvoiceFields } from "../src/schema.js";

export const GRADED_FIELDS = [
  "document_type",
  "vendor_name",
  "invoice_number",
  "issue_date",
  "due_date",
  "currency",
  "po_number",
  "subtotal",
  "tax",
  "total",
  "line_items",
] as const;
export type GradedField = (typeof GRADED_FIELDS)[number];

export interface Grade {
  fields: Record<GradedField, boolean>;
  /** Did each rule check reach the same verdict as on the ground truth? */
  checks: Record<string, boolean>;
  /** For each cited key field in the ground truth: did the extraction cite the same page? */
  sourcePages: Record<string, boolean>;
  allFieldsCorrect: boolean;
}

const MONEY_TOL = 0.01;
const sameMoney = (a: number, b: number) => Math.abs(a - b) <= MONEY_TOL;
const normId = (s: string | null) => (s === null ? null : s.toUpperCase().replace(/\s+/g, ""));

export function gradeFields(expected: InvoiceFields, got: InvoiceFields): Record<GradedField, boolean> {
  return {
    document_type: got.document_type === expected.document_type,
    vendor_name: vendorKey(got.vendor_name) === vendorKey(expected.vendor_name),
    invoice_number: normId(got.invoice_number) === normId(expected.invoice_number),
    issue_date: got.issue_date === expected.issue_date,
    due_date: got.due_date === expected.due_date,
    currency: got.currency.toUpperCase() === expected.currency.toUpperCase(),
    po_number: normId(got.po_number) === normId(expected.po_number),
    subtotal: sameMoney(got.subtotal, expected.subtotal),
    tax: sameMoney(got.tax, expected.tax),
    total: sameMoney(got.total, expected.total),
    // Same number of lines and the same amounts in the same order. Descriptions aren't
    // graded: wording differences (dashes, spacing) aren't errors that matter for AP.
    line_items:
      got.line_items.length === expected.line_items.length &&
      got.line_items.every((li, i) => sameMoney(li.amount, expected.line_items[i]!.amount)),
  };
}

export function grade(
  expected: { fields: InvoiceFields; expected_checks: Record<string, boolean> },
  got: InvoiceFields,
  gotChecks: CheckResult[],
): Grade {
  const fields = gradeFields(expected.fields, got);
  const checks: Record<string, boolean> = {};
  for (const [name, expectedPass] of Object.entries(expected.expected_checks)) {
    const c = gotChecks.find((k) => k.name === (name as CheckName));
    checks[name] = c !== undefined && c.passed === expectedPass;
  }
  const sourcePages: Record<string, boolean> = {};
  for (const field of KEY_FIELDS) {
    const exp = expected.fields.sources.find((s) => s.field === field);
    if (!exp) continue;
    sourcePages[field] = got.sources.some((s) => s.field === field && s.page === exp.page);
  }
  return { fields, checks, sourcePages, allFieldsCorrect: Object.values(fields).every(Boolean) };
}

/** A deliberately empty extraction, for the null-baseline self-test. */
export function nullFields(): InvoiceFields {
  return {
    document_type: "invoice",
    vendor_name: "",
    invoice_number: "",
    issue_date: "",
    due_date: null,
    currency: "",
    po_number: null,
    line_items: [],
    subtotal: 0,
    tax: 0,
    total: 0,
    sources: [],
  };
}
