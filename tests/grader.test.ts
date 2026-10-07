// The eval's grader, checked on known-good and known-bad inputs (eval-audit: "harness
// tested on known-good and known-bad"). No model is involved.
import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks.js";
import { grade, gradeFields, nullFields } from "../evals/grade.js";
import { caseExpected } from "./helpers.js";

const IDS = ["01-basic-usd", "02-eur-vat-de-format", "03-multipage-usd", "04-credit-note", "05-missing-po", "06-bad-totals-gbp", "07-duplicate", "08-due-before-issue", "09-jpy-no-decimals", "10-unknown-po-with-injection"];

describe("grader", () => {
  it("scores the ground truth (oracle) as fully correct on every case", () => {
    for (const id of IDS) {
      const e = caseExpected(id);
      const g = grade(e, e.fields, runChecks(e.fields, e.context));
      expect(g.allFieldsCorrect, id).toBe(true);
      expect(Object.values(g.checks).every(Boolean), id).toBe(true);
      expect(Object.values(g.sourcePages).every(Boolean), id).toBe(true);
    }
  });

  it("fails an empty extraction (null baseline) on every case", () => {
    for (const id of IDS) {
      const e = caseExpected(id);
      expect(grade(e, nullFields(), runChecks(nullFields(), e.context)).allFieldsCorrect, id).toBe(false);
    }
  });

  it("is not too strict: case, spacing and vendor punctuation don't matter", () => {
    const e = caseExpected("07-duplicate");
    const got = { ...e.fields, vendor_name: "SAMPLE FREIGHT LINES, INC", invoice_number: "sfl-117950", currency: "usd" };
    expect(Object.values(gradeFields(e.fields, got)).every(Boolean)).toBe(true);
  });

  it("is not too lenient: a plausible wrong total, date or PO is caught", () => {
    const e = caseExpected("01-basic-usd");
    expect(gradeFields(e.fields, { ...e.fields, total: e.fields.total + 1 }).total).toBe(false);
    expect(gradeFields(e.fields, { ...e.fields, due_date: "2026-10-15" }).due_date).toBe(false);
    expect(gradeFields(e.fields, { ...e.fields, po_number: null }).po_number).toBe(false);
    expect(gradeFields(e.fields, { ...e.fields, line_items: e.fields.line_items.slice(1) }).line_items).toBe(false);
  });

  it("the bad-totals case expects the printed numbers, not corrected ones", () => {
    const e = caseExpected("06-bad-totals-gbp");
    const corrected = { ...e.fields, subtotal: 1230, tax: 246, total: 1476 };
    const g = gradeFields(e.fields, corrected);
    expect(g.subtotal).toBe(false);
  });
});
