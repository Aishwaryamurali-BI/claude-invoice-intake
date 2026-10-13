// Cost of one Claude call, computed from the token counts the API returns.
//
// Prices are USD per million tokens, from Anthropic's model pricing and prompt-caching
// documentation as read in October 2026:
//  - Opus 5.5: $4 input / $20 output, cache reads $0.20.
//  - Opus 5 and Opus 4.8: $5 / $25; cache reads use the general ~0.1x rule.
//    These two are listed only because `fallbacks: "default"` can hand a refused
//    request to them, and that attempt is billed at the fallback model's rates.
//  - Cache writes: 1.25x the input price for the 5-minute TTL, 2x for the 1-hour TTL.
// Re-check these against the live pricing page before quoting a number to anyone.

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES_PER_MTOK: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};

export const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;

/** The subset of the API's `usage` object this function reads. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

export interface CostLine {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  costUsd: number;
}

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`No price on file for model "${model}". Add it to PRICES_PER_MTOK before trusting a cost number.`);
  }
}

/**
 * Cost of one model attempt. `input_tokens` from the API is only the *uncached*
 * part of the prompt; cached reads and cache writes are reported separately and
 * priced separately, so all three are added here.
 */
export function costOf(model: string, u: UsageLike): CostLine {
  // Accept a dated snapshot ID (e.g. "...-20261001") by its base ID.
  const p = PRICES_PER_MTOK[model] ?? PRICES_PER_MTOK[model.replace(/-\d{8}$/, "")];
  if (!p) throw new UnknownModelPriceError(model);

  const cacheRead = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  // Prefer the per-TTL breakdown; if absent, treat every write as 5-minute (the default TTL).
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : created;

  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      cacheRead * p.cacheRead +
      w5m * p.input * CACHE_WRITE_MULTIPLIER["5m"] +
      w1h * p.input * CACHE_WRITE_MULTIPLIER["1h"]) /
    1_000_000;

  return {
    model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: cacheRead,
    cache_write_5m_tokens: w5m,
    cache_write_1h_tokens: w1h,
    costUsd: usd,
  };
}

/** One entry of `usage.iterations` (present when server-side fallback is used). */
export interface IterationLike extends UsageLike {
  type: string;
  model?: string | null;
}

/**
 * Total cost of a response. When `usage.iterations` is present it is the per-attempt
 * source of truth (top-level `usage` covers only the attempt that produced the reply),
 * so every attempt is priced at its own model's rates. Attempts that were refused before
 * any output are counted too, which can overstate the bill slightly; see the API docs on
 * how refusals are billed.
 */
export function costOfResponse(
  requestedModel: string,
  servedModel: string,
  usage: UsageLike & { iterations?: IterationLike[] | null },
): { totalUsd: number; lines: CostLine[] } {
  const its = (usage.iterations ?? []).filter((i) => i.type === "message" || i.type === "fallback_message");
  const lines =
    its.length > 0
      ? its.map((i) => costOf(i.model ?? (i.type === "message" ? requestedModel : servedModel), i))
      : [costOf(servedModel, usage)];
  return { totalUsd: lines.reduce((s, l) => s + l.costUsd, 0), lines };
}
