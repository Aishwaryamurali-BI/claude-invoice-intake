// What actually goes over the wire: the real Anthropic SDK pointed at a local fake API
// server. Checks the HTTP request (headers + JSON body) the SDK builds from our params.
// The fake server's reply is canned; this says nothing about Claude's accuracy.
import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractInvoice, MODEL } from "../src/extract.js";
import { OPEN_POS, caseExpected, casePdf } from "./helpers.js";

let server: Server;
let baseURL: string;
const seen: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: MODEL,
          stop_reason: "end_turn",
          stop_sequence: null,
          content: [{ type: "text", text: JSON.stringify(caseExpected("01-basic-usd").fields) }],
          // Canned numbers for the fake server, not measurements.
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("HTTP request sent by the SDK", () => {
  it("matches the documented shape for Opus 5.5 extraction", async () => {
    const client = new Anthropic({ apiKey: "test-key-not-real", baseURL });
    const r = await extractInvoice(casePdf("01-basic-usd"), { mode: "live", client, context: { knownInvoices: [], purchaseOrders: OPEN_POS } });
    expect(r.mode).toBe("live");

    const req = seen[0]!;
    expect(req.path).toMatch(/^\/v1\/messages/);
    expect(req.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    const b = req.body as {
      model: string;
      fallbacks: unknown;
      thinking?: unknown;
      betas?: unknown;
      output_config: { effort: string; format: { type: string; schema: { type: string; additionalProperties: boolean; required: string[] } } };
      system: { type: string; cache_control: unknown }[];
      messages: { content: { type: string; source?: { type: string; media_type: string } }[] }[];
    };
    expect(b.model).toBe("claude-opus-5-5");
    expect(b.fallbacks).toBe("default");
    expect(b.thinking).toBeUndefined();
    expect(b.betas).toBeUndefined(); // sent as a header, not in the body
    expect(b.output_config.effort).toBe("low");
    expect(b.output_config.format.type).toBe("json_schema");
    expect(b.output_config.format.schema.additionalProperties).toBe(false);
    expect(b.output_config.format.schema.required).toEqual(expect.arrayContaining(["vendor_name", "sources", "line_items"]));
    expect("parse" in b.output_config.format).toBe(false); // the helper's parse() stays client-side
    expect(b.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(b.messages[0]!.content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
  });
});
