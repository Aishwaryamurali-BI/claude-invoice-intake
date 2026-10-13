import { describe, expect, it } from "vitest";
import { runChecks, vendorKey, type CheckContext, type CheckName } from "../src/checks.js";
import type { InvoiceFields } from "../src/schema.js";
import { OPEN_POS, caseExpected } from "./helpers.js";

function base(): InvoiceFields {
  return {
    document_type: "invoice",
    vendor_name: "Example Pallet Supply LLC",
    invoice_number: "INV-1",
    issue_date: "2026-09-01",
    due_date: "2026-10-01",
    currency: "USD",
    po_number: "PO-4410",
    line_items: [
      { description: "a", quantity: 2, unit_price: 10, amount: 20 },
      { description: "b", quantity: 1, unit_price: 5.5, amount: 5.5 },
    ],
    subtotal: 25.5,
    tax: 2.04,
    total: 27.54,
    sources: [
      { field: "vendor_name", page: 1, quote: "Example Pallet Supply LLC" },
      { field: "invoice_number", page: 1, quote: "Invoice No.: INV-1" },
      { field: "issue_date", page: 1, quote: "Invoice Date: Sep 1, 2026" },
      { field: "due_date", page: 1, quote: "Due Date: Oct 1, 2026" },
      { field: "currency", page: 1, quote: "Currency: USD" },
      { field: "po_number", page: 1, quote: "PO Number: PO-4410" },
      { field: "subtotal", page: 1, quote: "Subtotal: $25.50" },
      { field: "tax", page: 1, quote: "Tax: $2.04" },
      { field: "total", page: 1, quote: "Total due: $27.54" },
    ],
  };
}

const ctx: CheckContext = { knownInvoices: [], purchaseOrders: OPEN_POS };
const failed = (f: InvoiceFields, c = ctx) => runChecks(f, c).filter((r) => !r.passed).map((r) => r.name);

describe("rule checks", () => {
  it("passes a clean invoice", () => {
    expect(failed(base())).toEqual([]);
  });

  it("catches line items that don't add up to the subtotal", () => {
    const f = { ...base(), subtotal: 30, total: 32.04 };
    expect(failed(f)).toEqual(["line_items_sum_to_subtotal"]);
  });

  it("tolerates float noise up to one cent", () => {
    const f = base();
    f.line_items = [0.1, 0.2].map((a) => ({ description: "x", quantity: 1, unit_price: a, amount: a }));
    f.subtotal = 0.3;
    f.tax = 0;
    f.total = 0.3;
    expect(failed(f)).not.toContain("line_items_sum_to_subtotal");
  });

  it("catches subtotal + tax != total", () => {
    expect(failed({ ...base(), total: 28 })).toEqual(["subtotal_plus_tax_equals_total"]);
  });

  it("fails when there are no line items", () => {
    expect(failed({ ...base(), line_items: [] })).toContain("line_items_sum_to_subtotal");
  });

  it("catches a due date before the issue date, allows the same day", () => {
    expect(failed({ ...base(), due_date: "2026-08-31" })).toEqual(["dates_valid_and_due_on_or_after_issue"]);
    expect(failed({ ...base(), due_date: "2026-09-01" })).toEqual([]);
  });

  it("rejects impossible or badly formatted dates", () => {
    expect(failed({ ...base(), issue_date: "2026-02-30" })).toContain("dates_valid_and_due_on_or_after_issue");
    expect(failed({ ...base(), due_date: "01/10/2026" })).toContain("dates_valid_and_due_on_or_after_issue");
  });

  it("needs a due date on an invoice but not on a credit note", () => {
    expect(failed({ ...base(), due_date: null })).toContain("dates_valid_and_due_on_or_after_issue");
    expect(failed({ ...base(), document_type: "credit_note", due_date: null, po_number: null })).not.toContain(
      "dates_valid_and_due_on_or_after_issue",
    );
  });

  it("flags a missing PO and an unknown PO; a credit note needs none", () => {
    expect(failed({ ...base(), po_number: null })).toEqual(["po_exists"]);
    expect(failed({ ...base(), po_number: "PO-9999", sources: base().sources.map((s) => (s.field === "po_number" ? { ...s, quote: "PO Number: PO-9999" } : s)) })).toEqual(["po_exists"]);
    expect(failed({ ...base(), po_number: "po-4410" })).not.toContain("po_exists"); // case-insensitive
    expect(failed({ ...base(), document_type: "credit_note", po_number: null })).toEqual([]);
  });

  it("flags a duplicate invoice number from the same vendor, ignoring punctuation/case in the name", () => {
    const known = { knownInvoices: [{ vendor_name: "example pallet supply, llc", invoice_number: "inv-1" }], purchaseOrders: OPEN_POS };
    expect(failed(base(), known)).toEqual(["not_duplicate"]);
    const otherVendor = { knownInvoices: [{ vendor_name: "Someone Else Ltd", invoice_number: "INV-1" }], purchaseOrders: OPEN_POS };
    expect(failed(base(), otherVendor)).toEqual([]);
  });

  it("requires a citation for every non-null key field", () => {
    const f = base();
    f.sources = f.sources.filter((s) => s.field !== "total");
    expect(runChecks(f, ctx).find((c) => c.name === "key_fields_cited")).toMatchObject({ passed: false, detail: "total: no source" });
  });

  it("catches a citation whose quote doesn't contain the value", () => {
    const f = base();
    f.sources = f.sources.map((s) => (s.field === "invoice_number" ? { ...s, quote: "Invoice No.: INV-7" } : s));
    expect(failed(f)).toEqual(["key_fields_cited"]);
  });

  it("normalises vendor names for duplicate matching", () => {
    expect(vendorKey("Sample Freight Lines, Inc.")).toBe(vendorKey("sample freight lines inc"));
  });

  it("keeps non-Latin vendor names apart instead of collapsing them to nothing", () => {
    expect(vendorKey("株式会社サンプル")).not.toBe(vendorKey("株式会社テスト"));
    expect(vendorKey("Müller GmbH")).toBe(vendorKey("müller gmbh"));
    expect(vendorKey("株式会社サンプル")).not.toBe("");
  });

  it("allows one unit of rounding on a zero-decimal currency, one cent elsewhere", () => {
    const jpy = { ...base(), currency: "JPY", line_items: [{ description: "a", quantity: 3, unit_price: 333, amount: 999 }], subtotal: 1000, tax: 100, total: 1100 };
    expect(failed(jpy)).not.toContain("line_items_sum_to_subtotal"); // 999 vs 1000: one yen
    expect(failed({ ...jpy, subtotal: 1001, total: 1101 })).toContain("line_items_sum_to_subtotal"); // two yen
    expect(failed({ ...base(), subtotal: 26.5, total: 28.54 })).toContain("line_items_sum_to_subtotal"); // USD: one dollar off
  });

  it("agrees with every eval case's expected verdicts on its ground truth", () => {
    const ids = ["01-basic-usd", "02-eur-vat-de-format", "03-multipage-usd", "04-credit-note", "05-missing-po", "06-bad-totals-gbp", "07-duplicate", "08-due-before-issue", "09-jpy-no-decimals", "10-unknown-po-with-injection"];
    for (const id of ids) {
      const e = caseExpected(id);
      const got = Object.fromEntries(runChecks(e.fields, e.context).map((c) => [c.name, c.passed])) as Record<CheckName, boolean>;
      expect(got, id).toEqual(e.expected_checks);
    }
  });
});
