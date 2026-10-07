// Deterministic checks on extracted invoice fields. Plain code, no AI:
// the same input always gives the same answer, and every failure says why.
import { KEY_FIELDS, type InvoiceFields } from "./schema.js";

export type CheckName =
  | "line_items_sum_to_subtotal"
  | "subtotal_plus_tax_equals_total"
  | "dates_valid_and_due_on_or_after_issue"
  | "po_exists"
  | "not_duplicate"
  | "key_fields_cited";

export const CHECK_NAMES: CheckName[] = [
  "line_items_sum_to_subtotal",
  "subtotal_plus_tax_equals_total",
  "dates_valid_and_due_on_or_after_issue",
  "po_exists",
  "not_duplicate",
  "key_fields_cited",
];

export interface CheckResult {
  name: CheckName;
  passed: boolean;
  detail: string;
}

export interface CheckContext {
  /** Invoices already on file or pending (rejected ones excluded by the caller). */
  knownInvoices: { vendor_name: string; invoice_number: string }[];
  /** Open purchase order numbers. */
  purchaseOrders: string[];
}

/** Money tolerance: one cent (or one unit for zero-decimal currencies like JPY). */
const TOLERANCE = 0.01;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "ACME Supplies, Ltd." and "acme supplies ltd" are the same vendor for duplicate purposes. */
export function vendorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function invoiceKey(no: string): string {
  return no.toUpperCase().replace(/\s+/g, "");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Does the quote plausibly contain the value? Only used for text-like fields. */
function quoteContains(quote: string, value: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(value).length > 0 && norm(quote).includes(norm(value));
}

export function runChecks(f: InvoiceFields, ctx: CheckContext): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. Line items add up to the subtotal.
  const lineSum = round2(f.line_items.reduce((s, li) => s + li.amount, 0));
  results.push({
    name: "line_items_sum_to_subtotal",
    passed: f.line_items.length > 0 && Math.abs(lineSum - f.subtotal) <= TOLERANCE,
    detail:
      f.line_items.length === 0
        ? "no line items extracted"
        : `line items sum to ${lineSum}, subtotal is ${f.subtotal}`,
  });

  // 2. Subtotal + tax = total.
  const expectedTotal = round2(f.subtotal + f.tax);
  results.push({
    name: "subtotal_plus_tax_equals_total",
    passed: Math.abs(expectedTotal - f.total) <= TOLERANCE,
    detail: `${f.subtotal} + ${f.tax} = ${expectedTotal}, total is ${f.total}`,
  });

  // 3. Dates are real calendar dates and the due date is not before the issue date.
  //    Equal dates are allowed ("due on receipt").
  let dateOk = isRealDate(f.issue_date);
  let dateDetail = dateOk ? `issued ${f.issue_date}` : `issue date "${f.issue_date}" is not a valid YYYY-MM-DD date`;
  if (dateOk) {
    if (f.due_date === null) {
      dateOk = f.document_type === "credit_note";
      dateDetail += dateOk ? ", no due date (credit note)" : ", no due date on an invoice";
    } else if (!isRealDate(f.due_date)) {
      dateOk = false;
      dateDetail += `, due date "${f.due_date}" is not a valid YYYY-MM-DD date`;
    } else if (f.due_date < f.issue_date) {
      dateOk = false;
      dateDetail += `, due ${f.due_date} is before the issue date`;
    } else {
      dateDetail += `, due ${f.due_date}`;
    }
  }
  results.push({ name: "dates_valid_and_due_on_or_after_issue", passed: dateOk, detail: dateDetail });

  // 4. PO number is present and matches an open purchase order.
  //    Credit notes don't need a PO.
  if (f.document_type === "credit_note" && f.po_number === null) {
    results.push({ name: "po_exists", passed: true, detail: "credit note, no PO required" });
  } else if (f.po_number === null) {
    results.push({ name: "po_exists", passed: false, detail: "no PO number on the invoice" });
  } else {
    const found = ctx.purchaseOrders.some((po) => invoiceKey(po) === invoiceKey(f.po_number!));
    results.push({
      name: "po_exists",
      passed: found,
      detail: found ? `PO ${f.po_number} is open` : `PO ${f.po_number} not found in open purchase orders`,
    });
  }

  // 5. Same invoice number from the same vendor hasn't been seen before.
  const dup = ctx.knownInvoices.find(
    (k) => vendorKey(k.vendor_name) === vendorKey(f.vendor_name) && invoiceKey(k.invoice_number) === invoiceKey(f.invoice_number),
  );
  results.push({
    name: "not_duplicate",
    passed: !dup,
    detail: dup ? `${f.vendor_name} ${f.invoice_number} is already on file` : "first time seen",
  });

  // 6. Every key field that has a value cites a page and a quote; for text fields
  //    the quote must actually contain the value (catches made-up citations).
  const problems: string[] = [];
  for (const field of KEY_FIELDS) {
    const value = f[field];
    if (value === null) continue;
    const src = f.sources.filter((s) => s.field === field);
    if (src.length === 0) {
      problems.push(`${field}: no source`);
      continue;
    }
    if (src.some((s) => s.page < 1 || s.quote.trim() === "")) {
      problems.push(`${field}: empty quote or bad page`);
      continue;
    }
    if ((field === "invoice_number" || field === "po_number") && !src.some((s) => quoteContains(s.quote, String(value)))) {
      problems.push(`${field}: quote does not contain "${value}"`);
    }
  }
  results.push({
    name: "key_fields_cited",
    passed: problems.length === 0,
    detail: problems.length === 0 ? "every key field cites a page and quote" : problems.join("; "),
  });

  return results;
}

export const allPassed = (checks: CheckResult[]) => checks.every((c) => c.passed);
