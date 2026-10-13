import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthConfigError, TokenAuth } from "../src/auth.js";
import { createHttpApp } from "../src/mcp-server.js";
import type { InvoiceStore } from "../src/store.js";
import { TEST_AUTH_ENV, TEST_TOKENS, casePdf, tempStore } from "./helpers.js";

describe("TokenAuth", () => {
  const auth = new TokenAuth(TEST_AUTH_ENV);

  it("maps each token to its principal and scopes", () => {
    expect(auth.verify(`Bearer ${TEST_TOKENS.reader}`)).toEqual({ name: "n8n-reader", scopes: ["read"] });
    expect(auth.verify(`Bearer ${TEST_TOKENS.aishu}`)).toEqual({ name: "aishu", scopes: ["read", "approve"] });
  });

  it("rejects missing, malformed and wrong tokens", () => {
    expect(auth.verify(undefined)).toBeNull();
    expect(auth.verify(TEST_TOKENS.reader)).toBeNull(); // no "Bearer"
    expect(auth.verify(`Basic ${TEST_TOKENS.reader}`)).toBeNull();
    expect(auth.verify(`Bearer ${TEST_TOKENS.reader}x`)).toBeNull();
    expect(auth.verify(`Bearer ${TEST_TOKENS.reader.slice(0, -1)}`)).toBeNull();
  });

  it("refuses short tokens, duplicate names and an empty config at startup", () => {
    expect(() => new TokenAuth({ READ_TOKENS: "a=short" })).toThrow(AuthConfigError);
    expect(() => new TokenAuth({ READ_TOKENS: `a=${"x".repeat(40)}`, APPROVER_TOKENS: `a=${"y".repeat(40)}` })).toThrow(AuthConfigError);
    expect(() => new TokenAuth({})).toThrow(AuthConfigError);
  });

  it("never puts a token in an error message", () => {
    const secret = "s".repeat(31); // one short of the minimum, so startup fails
    let message = "";
    try {
      new TokenAuth({ READ_TOKENS: `svc=${secret}` });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/shorter than 32/);
    expect(message).not.toContain(secret);
  });

  it("enforces who may approve as whom", () => {
    const aishu = auth.verify(`Bearer ${TEST_TOKENS.aishu}`)!;
    const n8n = auth.verify(`Bearer ${TEST_TOKENS.n8nApprover}`)!;
    const reader = auth.verify(`Bearer ${TEST_TOKENS.reader}`)!;
    expect(auth.checkApprover(aishu, "aishu")).toBeNull();
    expect(auth.checkApprover(aishu, "sam")).toMatch(/cannot approve as sam/); // a person can't approve as someone else
    expect(auth.checkApprover(n8n, "sam")).toBeNull(); // the service relays a listed human
    expect(auth.checkApprover(n8n, "mallory")).toMatch(/not in APPROVERS/);
    expect(auth.checkApprover(reader, "aishu")).toMatch(/read-only/);
  });

  it("an approver token that is neither a listed human nor a declared relay fails at startup", () => {
    // Before this check, a token left off APPROVERS was silently treated as a relay and could approve as anyone.
    expect(() => new TokenAuth({ APPROVER_TOKENS: `svc=${"x".repeat(40)}`, APPROVERS: "aishu" })).toThrow(/neither APPROVERS nor RELAY_PRINCIPALS/);
    const declared = new TokenAuth({ APPROVER_TOKENS: `svc=${"x".repeat(40)}`, APPROVERS: "aishu", RELAY_PRINCIPALS: "svc" });
    expect(declared.checkApprover({ name: "svc", scopes: ["read", "approve"] }, "aishu")).toBeNull();
    expect(declared.checkApprover({ name: "svc", scopes: ["read", "approve"] }, "svc")).toMatch(/not in APPROVERS/);
  });
});

describe("HTTP transport auth (real Streamable HTTP server on a random port)", () => {
  let server: Server;
  let url: URL;
  let store: InvoiceStore;

  beforeAll(async () => {
    store = tempStore();
    const app = createHttpApp({ store, auth: new TokenAuth(TEST_AUTH_ENV) });
    server = await new Promise<Server>((res) => {
      const s = app.listen(0, "127.0.0.1", () => res(s));
    });
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });
  afterAll(() => {
    server.close();
    store.close();
  });

  async function clientWith(token: string) {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  }

  it("answers 401 to a request with no token or a wrong token, without echoing it", async () => {
    for (const header of [undefined, "Bearer not-a-real-token-but-long-enough-000000"]) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(header ? { authorization: header } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("not-a-real-token");
    }
  });

  it("an MCP client with a wrong token can't connect", async () => {
    await expect(clientWith("wrong-token-wrong-token-wrong-token-00")).rejects.toThrow();
  });

  it("a read token sees only read tools and cannot approve", async () => {
    const reader = await clientWith(TEST_TOKENS.reader);
    const names = (await reader.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["extract_invoice", "list_pending_approvals", "payables_forecast"]);

    const ex = (await reader.callTool({ name: "extract_invoice", arguments: { pdf_base64: casePdf("01-basic-usd").toString("base64") } })) as unknown as {
      structuredContent: { id: string };
    };
    const res = (await reader.callTool({ name: "approve_invoice", arguments: { invoice_id: ex.structuredContent.id, approver: "aishu" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(store.get(ex.structuredContent.id)!.status).toBe("pending_approval");
    await reader.close();
  });

  it("an approver token can approve, and the record names the human and the token used", async () => {
    const reader = await clientWith(TEST_TOKENS.reader);
    const ex = (await reader.callTool({ name: "extract_invoice", arguments: { pdf_base64: casePdf("09-jpy-no-decimals").toString("base64") } })) as unknown as {
      structuredContent: { id: string };
    };
    const n8n = await clientWith(TEST_TOKENS.n8nApprover);
    const ok = (await n8n.callTool({ name: "approve_invoice", arguments: { invoice_id: ex.structuredContent.id, approver: "sam" } })) as { isError?: boolean };
    expect(ok.isError).toBeFalsy();
    expect(store.get(ex.structuredContent.id)).toMatchObject({ status: "approved", decided_by: "sam", decided_via: "n8n-approver" });
    await reader.close();
    await n8n.close();
  });

  it("rejects a Host header that isn't localhost (DNS-rebinding protection)", async () => {
    // node:http, because fetch won't let you override the Host header.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TEST_TOKENS.aishu}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
