import { describe, expect, it } from "vitest";
import { costOf, costOfResponse, UnknownModelPriceError } from "../src/cost.js";

// Token counts below are made-up test inputs, not measurements.
describe("cost math", () => {
  it("prices Opus 5.5 input, output, cache reads and 5-minute cache writes", () => {
    const line = costOf("claude-opus-5-5", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 1000,
    });
    // 1000*$4 + 500*$20 + 2000*$0.20 + 1000*$4*1.25, per million tokens
    expect(line.costUsd).toBeCloseTo((4000 + 10000 + 400 + 5000) / 1e6, 10);
    expect(line.cache_write_5m_tokens).toBe(1000);
  });

  it("uses the per-TTL breakdown when present (1-hour writes cost 2x input)", () => {
    const line = costOf("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1500,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1000 },
    });
    expect(line.costUsd).toBeCloseTo((500 * 4 * 1.25 + 1000 * 4 * 2) / 1e6, 10);
  });

  it("treats missing cache fields as zero", () => {
    expect(costOf("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 }).costUsd).toBeCloseTo(4, 10);
  });

  it("refuses to guess a price for an unknown model", () => {
    expect(() => costOf("some-other-model", { input_tokens: 1, output_tokens: 1 })).toThrow(UnknownModelPriceError);
  });

  it("prices each fallback attempt at its own model's rates", () => {
    const { totalUsd, lines } = costOfResponse("claude-opus-5-5", "claude-opus-4-8", {
      input_tokens: 1000,
      output_tokens: 200,
      iterations: [
        { type: "message", model: null, input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    });
    expect(lines.map((l) => l.model)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
    expect(totalUsd).toBeCloseTo((1000 * 4 + 1000 * 5 + 200 * 25) / 1e6, 10);
  });

  it("falls back to top-level usage when there are no iterations", () => {
    const { totalUsd } = costOfResponse("claude-opus-5-5", "claude-opus-5-5", { input_tokens: 100, output_tokens: 100 });
    expect(totalUsd).toBeCloseTo((100 * 4 + 100 * 20) / 1e6, 10);
  });
});
