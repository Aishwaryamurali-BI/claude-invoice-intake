// Per-user bearer tokens with two scopes.
//
//   READ_TOKENS="n8n-reader=<token>"                  -> scope "read"
//   APPROVER_TOKENS="aishu=<token>,n8n-approver=<token>" -> scopes "read" + "approve"
//   APPROVERS="aishu,sam"                              -> humans allowed to approve
//
// Tokens live only in the environment. They are compared in constant time, and the
// token value is never put in an error, a log line or a tool result.
import { createHash, timingSafeEqual } from "node:crypto";

export type Scope = "read" | "approve";

export interface Principal {
  /** Who holds the token (a person or a service like "n8n-approver"). */
  name: string;
  scopes: Scope[];
}

interface TokenEntry {
  principal: Principal;
  digest: Buffer;
}

export class AuthConfigError extends Error {}

const MIN_TOKEN_LENGTH = 32;

// Hashing first gives both sides the same length, which timingSafeEqual requires,
// and means the raw token isn't kept around after startup.
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

function parseList(raw: string | undefined, scopes: Scope[], varName: string): TokenEntry[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((pair) => {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const token = pair.slice(eq + 1).trim();
    if (eq < 1 || !name) throw new AuthConfigError(`${varName}: each entry must look like name=token`);
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new AuthConfigError(`${varName}: token for "${name}" is shorter than ${MIN_TOKEN_LENGTH} characters`);
    }
    return { principal: { name, scopes }, digest: digest(token) };
  });
}

export class TokenAuth {
  private entries: TokenEntry[];
  readonly approvers: Set<string>;

  constructor(env: { READ_TOKENS?: string; APPROVER_TOKENS?: string; APPROVERS?: string }) {
    this.entries = [
      ...parseList(env.READ_TOKENS, ["read"], "READ_TOKENS"),
      ...parseList(env.APPROVER_TOKENS, ["read", "approve"], "APPROVER_TOKENS"),
    ];
    if (this.entries.length === 0) throw new AuthConfigError("no tokens configured: set READ_TOKENS and/or APPROVER_TOKENS");
    const names = this.entries.map((e) => e.principal.name);
    if (new Set(names).size !== names.length) throw new AuthConfigError("token names must be unique");
    const digests = this.entries.map((e) => e.digest.toString("hex"));
    if (new Set(digests).size !== digests.length) throw new AuthConfigError("two principals share the same token");
    this.approvers = new Set((env.APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  }

  /** Returns the principal for an Authorization header value, or null. Checks every entry (no early exit). */
  verify(authorizationHeader: string | undefined): Principal | null {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader ?? "");
    if (!m) return null;
    const presented = digest(m[1]!);
    let match: Principal | null = null;
    for (const e of this.entries) {
      if (timingSafeEqual(presented, e.digest)) match = e.principal;
    }
    return match;
  }

  /**
   * Decide whether `principal` may record a decision in the name of `approver`.
   * - A person approving with their own token can only approve as themselves.
   * - A service token (e.g. n8n relaying a Slack click) may name any listed approver.
   */
  checkApprover(principal: Principal, approver: string): string | null {
    if (!principal.scopes.includes("approve")) return "this token is read-only";
    if (!this.approvers.has(approver)) return `"${approver}" is not in APPROVERS`;
    if (this.approvers.has(principal.name) && principal.name !== approver) {
      return `token belongs to ${principal.name}, who cannot approve as ${approver}`;
    }
    return null;
  }
}
