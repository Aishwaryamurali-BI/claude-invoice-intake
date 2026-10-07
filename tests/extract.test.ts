// Tests for the extraction wrapper. The "live" tests use a stub client that returns
// canned API responses, so they check our request shape and response handling, not
// Claude's accuracy (that's what `npm run eval` is for, with a real key).
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  buildRequest,
  defaultMode,
  extractInvoice,
  ExtractionParseError,
  ExtractionRefusedError,
  ExtractionTruncatedError,
  isRequestedModel,
  MODEL,
  SYSTEM_PROMPT,
} from "../src/extract.js";
import { NoReplayFixtureError, REPLAY_LABEL } from "../src/replay.js";
import { OPEN_POS, caseExpected, casePdf } from "./helpers.js";

const context = { knownInvoices: [], purchaseOrders: OPEN_POS };

function stubClient(response: Record<string, unknown>) {
  const calls: { params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.push({ params, options });
          return { model: MODEL, stop_details: null, ...response };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

// Made-up token counts for the stub; not measurements.
const usage = { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 600, cache_creation_input_tokens: 0, cache_creation: null, iterations: null };

describe("mode selection", () => {
  it("is replay without credentials and live with a key, unless forced", () => {
    expect(defaultMode({})).toBe("replay");
    expect(defaultMode({ ANTHROPIC_API_KEY: "x" })).toBe("live");
    expect(defaultMode({ EXTRACT_MODE: "live" })).toBe("live"); // e.g. after `ant auth login`
    expect(defaultMode({ ANTHROPIC_API_KEY: "x", EXTRACT_MODE: "replay" })).toBe("replay");
  });
});

describe("replay mode", () => {
  it("returns the labelled ground truth with no usage and no cost", async () => {
    const r = await extractInvoice(casePdf("02-eur-vat-de-format"), { mode: "replay", context });
    expect(r.mode).toBe("replay");
    expect(r.label).toBe(REPLAY_LABEL);
    expect(r.usage).toBeNull();
    expect(r.costUsd).toBeNull();
    expect(r.fields).toEqual(caseExpected("02-eur-vat-de-format").fields);
    expect(r.allChecksPassed).toBe(true);
  });

  it("refuses an unknown PDF instead of inventing fields", async () => {
    await expect(extractInvoice(Buffer.from("%PDF-1.4 something else"), { mode: "replay", context })).rejects.toThrow(NoReplayFixtureError);
  });
});

describe("live request shape (stub client)", () => {
  it("sends the documented Opus 5.5 request", () => {
    const p = buildRequest("QUJD");
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config.effort).toBe("low");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect("thinking" in p).toBe(false); // always on for Opus 5.5; omitted = adaptive
    expect(p.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[0]!.text).toBe(SYSTEM_PROMPT);
    expect(p.messages[0]!.content[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
  });

  it("keeps the cached prefix free of per-request data", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(JSON.stringify(buildRequest("A").system)).toBe(JSON.stringify(buildRequest("B").system));
  });

  it("parses a valid reply, runs checks and prices the usage", async () => {
    const fields = caseExpected("01-basic-usd").fields;
    const { client, calls } = stubClient({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(fields) }], usage });
    const r = await extractInvoice(casePdf("01-basic-usd"), { mode: "live", client, context });
    expect(r.mode).toBe("live");
    expect(r.label).toBe(`LIVE: ${MODEL}`);
    expect(r.fields).toEqual(fields);
    expect(r.allChecksPassed).toBe(true);
    expect(r.usage!.cache_read_input_tokens).toBe(600);
    expect(r.costUsd).toBeCloseTo((1000 * 4 + 400 * 20 + 600 * 0.2) / 1e6, 10);
    expect(calls[0]!.options).toMatchObject({ maxRetries: 2, timeout: 120000 });
  });

  it("checks stop_reason before reading content: refusal", async () => {
    const { client } = stubClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage });
    await expect(extractInvoice(casePdf("01-basic-usd"), { mode: "live", client, context })).rejects.toMatchObject({
      constructor: ExtractionRefusedError,
      category: "cyber",
    });
  });

  it("checks stop_reason before reading content: max_tokens", async () => {
    const { client } = stubClient({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"document_type":"inv' }], usage });
    await expect(extractInvoice(casePdf("01-basic-usd"), { mode: "live", client, context })).rejects.toBeInstanceOf(ExtractionTruncatedError);
  });

  it("rejects a reply that doesn't match the schema", async () => {
    const { client } = stubClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"vendor_name": 3}' }], usage });
    await expect(extractInvoice(casePdf("01-basic-usd"), { mode: "live", client, context })).rejects.toBeInstanceOf(ExtractionParseError);
  });

  it("labels a fallback-served reply and prices every attempt", async () => {
    const fields = caseExpected("01-basic-usd").fields;
    const { client } = stubClient({
      model: "claude-opus-4-8",
      stop_reason: "end_turn",
      content: [{ type: "fallback" }, { type: "text", text: JSON.stringify(fields) }],
      usage: {
        ...usage,
        iterations: [
          { type: "message", model: null, input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    });
    const r = await extractInvoice(casePdf("01-basic-usd"), { mode: "live", client, context });
    expect(r.fallbackUsed).toBe(true);
    expect(r.label).toMatch(/fallback model claude-opus-4-8/);
    expect(r.costLines.map((l) => l.model)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
  });

  it("recognises the requested model, including a dated snapshot", () => {
    expect(isRequestedModel("claude-opus-5-5")).toBe(true);
    expect(isRequestedModel("claude-opus-5-5-20261001")).toBe(true);
    expect(isRequestedModel("claude-opus-4-8")).toBe(false);
  });
});
