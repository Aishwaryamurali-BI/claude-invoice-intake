// MCP server over Streamable HTTP. The one integration surface for both Claude
// clients (Claude Code, Claude Desktop) and n8n.
//
// Least privilege:
//  - Every request needs a bearer token (src/auth.ts). Unknown token -> 401.
//  - A fresh McpServer is built per request with ONLY the tools that token's scopes
//    allow. A read-only token doesn't even see approve_invoice / reject_invoice.
//  - The write handlers re-check the scope anyway (defence in depth).
//  - Nothing is filed until a named human approver calls approve_invoice.
import express, { type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { TokenAuth, type Principal } from "./auth.js";
import { extractInvoice, type ExtractResult } from "./extract.js";
import { allPassed, refreshDuplicateCheck, type CheckContext } from "./checks.js";
import { payablesForecast } from "./forecast.js";
import { ApprovalError, InvoiceStore } from "./store.js";

export type Extractor = (pdf: Buffer, context: CheckContext) => Promise<ExtractResult>;

export interface ServerDeps {
  store: InvoiceStore;
  auth: TokenAuth;
  extract?: Extractor;
  today?: () => string; // YYYY-MM-DD, injectable for tests
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Log tool calls without arguments or results: invoices are client data. Never log tokens. */
function audit(principal: Principal, tool: string, outcome: string) {
  if (process.env.NODE_ENV === "test" || process.env.AUDIT_LOG === "off") return;
  console.log(JSON.stringify({ at: new Date().toISOString(), principal: principal.name, tool, outcome }));
}

export function createMcpServer(deps: ServerDeps, principal: Principal): McpServer {
  const { store, auth } = deps;
  const extract: Extractor = deps.extract ?? ((pdf, context) => extractInvoice(pdf, { context }));
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  const server = new McpServer({ name: "invoice-intake", version: "0.1.0" });
  const canApprove = principal.scopes.includes("approve");

  server.registerTool(
    "extract_invoice",
    {
      title: "Extract invoice",
      description:
        "Read an invoice or credit note PDF, extract its fields with Claude, run the rule checks, and stage it as pending_approval. " +
        "Does not file, pay or send anything. Returns the record id, fields with page/quote sources, check results and the cost of the call.",
      inputSchema: {
        pdf_base64: z.string().describe("The PDF file, base64-encoded"),
        source_name: z.string().optional().describe("Where it came from, e.g. the email attachment file name"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ pdf_base64, source_name }) => {
      const pdf = Buffer.from(pdf_base64, "base64");
      if (pdf.length === 0 || pdf.length > MAX_PDF_BYTES) return fail(`PDF must be between 1 byte and ${MAX_PDF_BYTES} bytes`);
      if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return fail("not a PDF (missing %PDF- header)");
      try {
        const context = { knownInvoices: store.knownInvoices(), purchaseOrders: store.purchaseOrders() };
        const r = await extract(pdf, context);
        // The duplicate list above was read before the model call, which can take a while. A second
        // copy of the same invoice may have been staged meanwhile (an n8n retry, or the same email
        // forwarded twice), so re-run that one check against the store as it is now, before staging.
        const checks = refreshDuplicateCheck(r.checks, r.fields, store.knownInvoices());
        const allChecksPassed = allPassed(checks);
        const rec = store.stage({
          pdf,
          sourceName: source_name ?? null,
          mode: r.mode,
          label: r.label,
          fields: r.fields,
          checks,
          allChecksPassed,
          costUsd: r.costUsd,
        });
        audit(principal, "extract_invoice", `staged ${rec.id} (${r.mode})`);
        return ok({
          id: rec.id,
          status: rec.status,
          mode: r.mode,
          label: r.label,
          all_checks_passed: allChecksPassed,
          failed_checks: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
          fields: r.fields,
          checks,
          usage: r.usage,
          cost_usd: r.costUsd,
          served_model: r.servedModel,
          fallback_used: r.fallbackUsed,
        });
      } catch (err) {
        audit(principal, "extract_invoice", `error ${(err as Error).name}`);
        return fail(`extraction failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description: "Invoices waiting for a human decision, oldest first, with their failed checks.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const pending = store.list("pending_approval").map((r) => ({
        id: r.id,
        vendor: r.fields.vendor_name,
        invoice_number: r.fields.invoice_number,
        document_type: r.fields.document_type,
        total: r.fields.total,
        currency: r.fields.currency,
        due_date: r.fields.due_date,
        all_checks_passed: r.all_checks_passed,
        failed_checks: r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
        extraction_label: r.extraction_label,
        created_at: r.created_at,
      }));
      audit(principal, "list_pending_approvals", `${pending.length} pending`);
      return ok({ count: pending.length, pending });
    },
  );

  server.registerTool(
    "payables_forecast",
    {
      title: "Payables forecast",
      description:
        "Amounts falling due in each of the next N weeks (default 4), per currency, plus an overdue bucket. " +
        "Approved invoices are 'committed'; pending ones are listed separately. Credit notes are subtracted. No FX conversion.",
      inputSchema: {
        weeks: z.number().int().min(1).max(12).optional(),
        as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date YYYY-MM-DD; defaults to today"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ weeks, as_of }) => {
      const f = payablesForecast(store.list(), as_of ?? today(), weeks ?? 4);
      audit(principal, "payables_forecast", "ok");
      return ok(f);
    },
  );

  if (canApprove) {
    server.registerTool(
      "approve_invoice",
      {
        title: "Approve and file invoice",
        description:
          "Record a human approval and file the invoice. Needs an approver-scope token and the name of the human approver " +
          "(must be in the server's APPROVERS list). If any check failed, override_reason is required.",
        inputSchema: {
          invoice_id: z.string(),
          approver: z.string().describe("The human who approved, e.g. their Slack handle as listed in APPROVERS"),
          note: z.string().optional(),
          override_reason: z.string().optional().describe("Required when one or more checks failed"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ invoice_id, approver, note, override_reason }) => {
        const denied = auth.checkApprover(principal, approver);
        if (denied) {
          audit(principal, "approve_invoice", "denied");
          return fail(`not allowed: ${denied}`);
        }
        try {
          const rec = store.approve(invoice_id, approver, principal.name, note, override_reason);
          audit(principal, "approve_invoice", `approved ${rec.id} by ${approver}`);
          return ok({ id: rec.id, status: rec.status, decided_by: rec.decided_by, decided_via: rec.decided_via, filed_path: rec.filed_path });
        } catch (err) {
          if (err instanceof ApprovalError) return fail(err.message);
          throw err;
        }
      },
    );

    server.registerTool(
      "reject_invoice",
      {
        title: "Reject invoice",
        description: "Record a human rejection with a reason. Nothing is filed. Needs an approver-scope token and a listed approver.",
        inputSchema: {
          invoice_id: z.string(),
          approver: z.string(),
          reason: z.string(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ invoice_id, approver, reason }) => {
        const denied = auth.checkApprover(principal, approver);
        if (denied) {
          audit(principal, "reject_invoice", "denied");
          return fail(`not allowed: ${denied}`);
        }
        try {
          const rec = store.reject(invoice_id, approver, principal.name, reason);
          audit(principal, "reject_invoice", `rejected ${rec.id} by ${approver}`);
          return ok({ id: rec.id, status: rec.status, decided_by: rec.decided_by, decided_via: rec.decided_via });
        } catch (err) {
          if (err instanceof ApprovalError) return fail(err.message);
          throw err;
        }
      },
    );
  }

  return server;
}

export interface HttpOptions {
  /** Hostnames accepted in the Host header (DNS-rebinding protection). Defaults to localhost only. */
  allowedHosts?: string[];
}

export function createHttpApp(deps: ServerDeps, opts: HttpOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(opts.allowedHosts?.length ? hostHeaderValidation(opts.allowedHosts) : localhostHostValidation());

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Authenticate before the body is even parsed.
  app.use("/mcp", (req: Request, res: Response, next) => {
    const principal = deps.auth.verify(req.headers.authorization);
    if (!principal) {
      res.status(401).set("WWW-Authenticate", 'Bearer realm="invoice-intake"').json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    res.locals.principal = principal;
    next();
  });
  app.use(express.json({ limit: "15mb" }));

  // Stateless Streamable HTTP: a new server + transport per POST, JSON responses
  // (no SSE), so plain HTTP clients like n8n's HTTP Request node can call it too.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createMcpServer(deps, res.locals.principal as Principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}

// ---- entry point -----------------------------------------------------------------

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.DATA_DIR ?? path.resolve(here, "..", "data");
  const store = new InvoiceStore(dataDir);
  const poFile = process.env.PURCHASE_ORDERS_FILE ?? path.resolve(here, "..", "fixtures", "purchase-orders.json");
  store.setPurchaseOrders((JSON.parse(readFileSync(poFile, "utf8")) as { open: string[] }).open);

  const auth = new TokenAuth(process.env);
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean);
  const app = createHttpApp({ store, auth }, { allowedHosts });
  app.listen(port, host, () => {
    console.log(`invoice-intake MCP server on http://${host}:${port}/mcp (data: ${dataDir})`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
