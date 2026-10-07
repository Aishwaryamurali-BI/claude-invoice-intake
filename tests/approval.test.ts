import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TokenAuth, type Principal } from "../src/auth.js";
import { payablesForecast } from "../src/forecast.js";
import { createMcpServer } from "../src/mcp-server.js";
import { ApprovalError, type InvoiceStore } from "../src/store.js";
import { TEST_AUTH_ENV, casePdf, tempStore } from "./helpers.js";

const auth = new TokenAuth(TEST_AUTH_ENV);
const READER: Principal = { name: "n8n-reader", scopes: ["read"] };
const AISHU: Principal = { name: "aishu", scopes: ["read", "approve"] };

async function client(store: InvoiceStore, principal: Principal) {
  const server = createMcpServer({ store, auth, today: () => "2026-10-01" }, principal);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  return c;
}

type Out = { isError?: boolean; content: { text?: string }[]; structuredContent?: Record<string, unknown> };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Out;
const extract = async (c: Client, id: string) => (await call(c, "extract_invoice", { pdf_base64: casePdf(id).toString("base64") })).structuredContent as { id: string; mode: string; cost_usd: number | null };

const filedCount = (store: InvoiceStore) => readdirSync(store.filedDir, { recursive: true }).filter((f) => String(f).endsWith(".json")).length;

describe("MCP tool list (in-process client)", () => {
  it("shows read tools to a reader and read + write tools to an approver", async () => {
    const store = tempStore();
    const r = await client(store, READER);
    const a = await client(store, AISHU);
    expect((await r.listTools()).tools.map((t) => t.name).sort()).toEqual(["extract_invoice", "list_pending_approvals", "payables_forecast"]);
    expect((await a.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "approve_invoice",
      "extract_invoice",
      "list_pending_approvals",
      "payables_forecast",
      "reject_invoice",
    ]);
    const tools = (await a.listTools()).tools;
    expect(tools.find((t) => t.name === "list_pending_approvals")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "approve_invoice")!.inputSchema.required).toEqual(expect.arrayContaining(["invoice_id", "approver"]));
  });
});

describe("approval gate", () => {
  it("extract stages the invoice; nothing is filed until a human approves", async () => {
    const store = tempStore();
    const r = await client(store, READER);
    const a = await client(store, AISHU);
    const ex = await extract(r, "01-basic-usd");
    expect(ex.mode).toBe("replay");
    expect(ex.cost_usd).toBeNull(); // replay never reports a cost
    expect(store.get(ex.id)!.status).toBe("pending_approval");
    expect(filedCount(store)).toBe(0);

    const res = await call(a, "approve_invoice", { invoice_id: ex.id, approver: "aishu" });
    expect(res.isError).toBeFalsy();
    const rec = store.get(ex.id)!;
    expect(rec).toMatchObject({ status: "approved", decided_by: "aishu", decided_via: "aishu" });
    expect(existsSync(rec.filed_path!)).toBe(true);
    expect(filedCount(store)).toBe(1);
  });

  it("an invoice with failed checks needs an override reason", async () => {
    const store = tempStore();
    const a = await client(store, AISHU);
    const ex = await extract(a, "05-missing-po");
    const denied = await call(a, "approve_invoice", { invoice_id: ex.id, approver: "aishu" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/override_reason/);
    expect(filedCount(store)).toBe(0);
    const okRes = await call(a, "approve_invoice", { invoice_id: ex.id, approver: "aishu", override_reason: "PO raised retroactively, see ticket" });
    expect(okRes.isError).toBeFalsy();
    expect(store.get(ex.id)!.decision_note).toMatch(/override: PO raised/);
  });

  it("a person can't approve in someone else's name", async () => {
    const store = tempStore();
    const a = await client(store, AISHU);
    const ex = await extract(a, "01-basic-usd");
    const res = await call(a, "approve_invoice", { invoice_id: ex.id, approver: "sam" });
    expect(res.isError).toBe(true);
    expect(store.get(ex.id)!.status).toBe("pending_approval");
  });

  it("rejecting files nothing, and a decided invoice can't be decided again", async () => {
    const store = tempStore();
    const a = await client(store, AISHU);
    const ex = await extract(a, "01-basic-usd");
    expect((await call(a, "reject_invoice", { invoice_id: ex.id, approver: "aishu", reason: "wrong entity" })).isError).toBeFalsy();
    expect(filedCount(store)).toBe(0);
    expect((await call(a, "approve_invoice", { invoice_id: ex.id, approver: "aishu" })).isError).toBe(true);
    expect(() => store.approve(ex.id, "aishu", "aishu")).toThrow(ApprovalError);
  });

  it("the store refuses an approval with a blank approver", async () => {
    const store = tempStore();
    const a = await client(store, AISHU);
    const ex = await extract(a, "01-basic-usd");
    expect(() => store.approve(ex.id, "  ", "aishu")).toThrow(/approver is required/);
  });

  it("a second copy of the same invoice is flagged as a duplicate; a rejected one isn't counted", async () => {
    const store = tempStore();
    const r = await client(store, READER);
    const a = await client(store, AISHU);
    const first = await extract(r, "01-basic-usd");
    const second = (await call(r, "extract_invoice", { pdf_base64: casePdf("01-basic-usd").toString("base64") })).structuredContent as { failed_checks: string[] };
    expect(second.failed_checks.join()).toMatch(/not_duplicate/);
    await call(a, "reject_invoice", { invoice_id: first.id, approver: "aishu", reason: "test" });
    expect(store.knownInvoices()).toHaveLength(1); // only the second, still pending
  });

  it("rejects input that isn't a PDF", async () => {
    const store = tempStore();
    const r = await client(store, READER);
    const res = await call(r, "extract_invoice", { pdf_base64: Buffer.from("hello").toString("base64") });
    expect(res.isError).toBe(true);
  });
});

describe("payables forecast", () => {
  it("buckets by week, separates committed from pending, subtracts credit notes, skips rejected", async () => {
    const store = tempStore();
    const a = await client(store, AISHU);
    const inv = await extract(a, "01-basic-usd"); // USD 2473.20 due 2026-10-14
    const multi = await extract(a, "03-multipage-usd"); // USD 7437.50 due 2026-10-03, stays pending
    const jpy = await extract(a, "09-jpy-no-decimals"); // JPY due 2026-10-31, outside 4 weeks from 10-01
    const late = await extract(a, "07-duplicate"); // due 2026-09-20 -> overdue
    const credit = await extract(a, "04-credit-note"); // no due date
    await call(a, "approve_invoice", { invoice_id: inv.id, approver: "aishu" });
    await call(a, "approve_invoice", { invoice_id: late.id, approver: "aishu" });
    await call(a, "reject_invoice", { invoice_id: jpy.id, approver: "aishu", reason: "x" });

    const f = payablesForecast(store.list(), "2026-10-01", 4);
    expect(f.buckets.map((b) => b.label)).toEqual(["overdue", "week 1", "week 2", "week 3", "week 4"]);
    expect(f.buckets[0]!.committed).toEqual({ USD: 1860 });
    expect(f.buckets[1]!.pending).toEqual({ USD: 7437.5 });
    expect(f.buckets[2]!.committed).toEqual({ USD: 2473.2 });
    expect(f.no_due_date.map((n) => n.id)).toEqual([credit.id]);
    const listed = f.buckets.flatMap((b) => b.invoices);
    expect(listed.some((i) => i.id === jpy.id)).toBe(false); // rejected
    expect(listed.find((i) => i.id === multi.id)?.status).toBe("pending_approval");

    // A credit note with a due date reduces that week.
    const fake = { ...store.get(credit.id)!, status: "approved" as const, fields: { ...store.get(credit.id)!.fields, due_date: "2026-10-12" } };
    const f2 = payablesForecast([...store.list().filter((r) => r.id !== credit.id), fake], "2026-10-01", 4);
    expect(f2.buckets[2]!.committed).toEqual({ USD: 2379.24 }); // 2473.20 - 93.96
  });

  it("the MCP tool returns the same shape", async () => {
    const store = tempStore();
    const r = await client(store, READER);
    const res = (await call(r, "payables_forecast", { as_of: "2026-10-01", weeks: 2 })).structuredContent as { buckets: unknown[] };
    expect(res.buckets).toHaveLength(3);
  });
});
