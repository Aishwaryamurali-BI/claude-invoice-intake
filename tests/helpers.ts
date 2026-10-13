import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvoiceStore } from "../src/store.js";
import type { InvoiceFields } from "../src/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const OPEN_POS = (JSON.parse(readFileSync(path.join(ROOT, "fixtures", "purchase-orders.json"), "utf8")) as { open: string[] }).open;

export function casePdf(id: string): Buffer {
  return readFileSync(path.join(ROOT, "evals", "cases", `${id}.pdf`));
}

export function caseExpected(id: string): { fields: InvoiceFields; context: { knownInvoices: { vendor_name: string; invoice_number: string }[]; purchaseOrders: string[] }; expected_checks: Record<string, boolean> } {
  return JSON.parse(readFileSync(path.join(ROOT, "evals", "cases", `${id}.expected.json`), "utf8"));
}

export function tempStore(): InvoiceStore {
  const s = new InvoiceStore(mkdtempSync(path.join(tmpdir(), "invoice-test-")));
  s.setPurchaseOrders(OPEN_POS);
  return s;
}

/** Test-only tokens (never used outside the test process). */
export const TEST_TOKENS = {
  reader: "reader-token-for-tests-0000000000000000",
  aishu: "aishu-token-for-tests-00000000000000000",
  n8nApprover: "n8n-approver-token-for-tests-0000000000",
};
export const TEST_AUTH_ENV = {
  READ_TOKENS: `n8n-reader=${TEST_TOKENS.reader}`,
  APPROVER_TOKENS: `aishu=${TEST_TOKENS.aishu},n8n-approver=${TEST_TOKENS.n8nApprover}`,
  APPROVERS: "aishu,sam",
  RELAY_PRINCIPALS: "n8n-approver",
};
