// Keyless walkthrough of the whole flow through the real MCP tools, in one process.
//
//   npm run demo
//
// With no API key, extraction runs in REPLAY mode (labelled on every result): the
// fields are the hand-written ground truth of the synthetic test invoices, not a model's
// output. Everything after extraction (checks, staging, approval gate, filing,
// forecast) is the real code. Uses a throwaway data folder.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TokenAuth, type Principal } from "./auth.js";
import { defaultMode } from "./extract.js";
import { createMcpServer } from "./mcp-server.js";
import { InvoiceStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

async function connect(store: InvoiceStore, auth: TokenAuth, principal: Principal) {
  const server = createMcpServer({ store, auth, today: () => "2026-10-01" }, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "demo", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

type ToolOut = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolOut;
const text = (r: ToolOut) => r.content.map((b) => b.text ?? "").join("");

async function main() {
  process.env.AUDIT_LOG = "off"; // keep the demo output readable
  const mode = defaultMode();
  console.log(`Extraction mode: ${mode.toUpperCase()}${mode === "replay" ? " (no API key found; no model will be called)" : " (this makes paid API calls)"}\n`);

  const dataDir = mkdtempSync(path.join(tmpdir(), "invoice-demo-"));
  const store = new InvoiceStore(dataDir);
  store.setPurchaseOrders((JSON.parse(readFileSync(path.join(root, "fixtures", "purchase-orders.json"), "utf8")) as { open: string[] }).open);
  // Demo-only tokens; the in-process transport skips HTTP auth, so these are never sent anywhere.
  const auth = new TokenAuth({
    READ_TOKENS: `n8n-reader=${"r".repeat(40)}`,
    APPROVER_TOKENS: `aishu=${"a".repeat(40)}`,
    APPROVERS: "aishu",
  });
  const reader = await connect(store, auth, { name: "n8n-reader", scopes: ["read"] });
  const approver = await connect(store, auth, { name: "aishu", scopes: ["read", "approve"] });

  console.log("Tools visible to a read-only token:", (await reader.listTools()).tools.map((t) => t.name).join(", "));
  console.log("Tools visible to an approver token:", (await approver.listTools()).tools.map((t) => t.name).join(", "), "\n");

  const ids: string[] = [];
  for (const file of ["01-basic-usd.pdf", "05-missing-po.pdf", "03-multipage-usd.pdf"]) {
    const pdf = readFileSync(path.join(root, "evals", "cases", file));
    const r = await call(reader, "extract_invoice", { pdf_base64: pdf.toString("base64"), source_name: file });
    if (r.isError) throw new Error(text(r));
    const s = r.structuredContent as { id: string; label: string; all_checks_passed: boolean; failed_checks: string[]; cost_usd: number | null; fields: { vendor_name: string; invoice_number: string; total: number; currency: string } };
    ids.push(s.id);
    console.log(`${file}: ${s.fields.vendor_name} ${s.fields.invoice_number} ${s.fields.currency} ${s.fields.total}`);
    console.log(`  ${s.label}`);
    console.log(`  checks: ${s.all_checks_passed ? "all passed" : "FAILED: " + s.failed_checks.join("; ")}`);
    console.log(`  cost: ${s.cost_usd === null ? "none (no model call)" : "$" + s.cost_usd.toFixed(4)}`);
  }

  console.log(`\nFiled so far: ${readdirSync(store.filedDir).length} (nothing is filed until a human approves)`);
  const pending = (await call(reader, "list_pending_approvals")).structuredContent as { count: number };
  console.log(`Pending approvals: ${pending.count}`);

  const denied = await call(reader, "approve_invoice", { invoice_id: ids[0], approver: "aishu" });
  console.log(`\nRead-only token tries approve_invoice -> ${denied.isError ? "refused: " + text(denied) : "UNEXPECTED SUCCESS"}`);

  const a1 = await call(approver, "approve_invoice", { invoice_id: ids[0], approver: "aishu", note: "matches PO" });
  console.log(`aishu approves invoice 1 -> ${text(a1).includes('"approved"') ? "approved and filed" : text(a1)}`);
  const a2 = await call(approver, "approve_invoice", { invoice_id: ids[1], approver: "aishu" });
  console.log(`aishu approves invoice 2 (failed PO check, no override) -> ${a2.isError ? "refused: " + text(a2) : "UNEXPECTED SUCCESS"}`);
  const a3 = await call(approver, "reject_invoice", { invoice_id: ids[1], approver: "aishu", reason: "no PO; asked vendor to reissue" });
  console.log(`aishu rejects invoice 2 -> ${a3.isError ? text(a3) : "rejected"}`);

  const f = (await call(reader, "payables_forecast", { as_of: "2026-10-01" })).structuredContent as {
    buckets: { label: string; start: string | null; end: string | null; committed: Record<string, number>; pending: Record<string, number> }[];
  };
  console.log("\nPayables forecast from 2026-10-01 (committed = approved, pending = awaiting a decision):");
  for (const b of f.buckets) {
    const fmt = (o: Record<string, number>) => Object.entries(o).map(([c, v]) => `${c} ${v}`).join(", ") || "-";
    console.log(`  ${b.label.padEnd(8)} ${b.start ?? "..."} to ${b.end}: committed ${fmt(b.committed)} | pending ${fmt(b.pending)}`);
  }

  await reader.close();
  await approver.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

await main();
