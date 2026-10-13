// Local storage: one SQLite file for records, plus folders for PDFs.
//
//   data/inbox/<id>.pdf      staged on extract (not filed)
//   data/filed/<vendor>/<invoice-no>.{pdf,json}   written ONLY by approve()
//
// Status flow: pending_approval -> approved (filed) | rejected. Nothing else moves an
// invoice to "approved", and approve() needs a named human approver.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { vendorKey, type CheckResult } from "./checks.js";
import type { InvoiceFields } from "./schema.js";

export type InvoiceStatus = "pending_approval" | "approved" | "rejected";

export interface InvoiceRecord {
  id: string;
  status: InvoiceStatus;
  source_name: string | null;
  extraction_mode: string;
  extraction_label: string;
  fields: InvoiceFields;
  checks: CheckResult[];
  all_checks_passed: boolean;
  cost_usd: number | null;
  created_at: string;
  decided_by: string | null;
  decided_via: string | null;
  decided_at: string | null;
  decision_note: string | null;
  filed_path: string | null;
}

interface Row {
  id: string;
  status: InvoiceStatus;
  source_name: string | null;
  extraction_mode: string;
  extraction_label: string;
  fields_json: string;
  checks_json: string;
  all_checks_passed: number;
  cost_usd: number | null;
  created_at: string;
  decided_by: string | null;
  decided_via: string | null;
  decided_at: string | null;
  decision_note: string | null;
  filed_path: string | null;
}

export class ApprovalError extends Error {}

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "_";

export class InvoiceStore {
  private db: Database.Database;
  readonly inboxDir: string;
  readonly filedDir: string;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.inboxDir = path.join(dataDir, "inbox");
    this.filedDir = path.join(dataDir, "filed");
    mkdirSync(this.inboxDir, { recursive: true });
    mkdirSync(this.filedDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "invoices.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','rejected')),
        source_name TEXT,
        extraction_mode TEXT NOT NULL,
        extraction_label TEXT NOT NULL,
        vendor_key TEXT NOT NULL,
        invoice_number TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        all_checks_passed INTEGER NOT NULL,
        cost_usd REAL,
        created_at TEXT NOT NULL,
        decided_by TEXT,
        decided_via TEXT,
        decided_at TEXT,
        decision_note TEXT,
        filed_path TEXT
      );
      CREATE TABLE IF NOT EXISTS purchase_orders (po_number TEXT PRIMARY KEY);
    `);
  }

  close() {
    this.db.close();
  }

  setPurchaseOrders(pos: string[]) {
    const tx = this.db.transaction((list: string[]) => {
      this.db.prepare("DELETE FROM purchase_orders").run();
      const ins = this.db.prepare("INSERT OR IGNORE INTO purchase_orders (po_number) VALUES (?)");
      for (const po of list) ins.run(po);
    });
    tx(pos);
  }

  purchaseOrders(): string[] {
    return (this.db.prepare("SELECT po_number FROM purchase_orders").all() as { po_number: string }[]).map((r) => r.po_number);
  }

  /** Invoices that count for duplicate detection: everything not rejected. */
  knownInvoices(): { vendor_name: string; invoice_number: string }[] {
    const rows = this.db.prepare("SELECT fields_json FROM invoices WHERE status != 'rejected'").all() as { fields_json: string }[];
    return rows.map((r) => {
      const f = JSON.parse(r.fields_json) as InvoiceFields;
      return { vendor_name: f.vendor_name, invoice_number: f.invoice_number };
    });
  }

  /** Stage an extracted invoice for approval. Does not file anything. */
  stage(input: {
    pdf: Buffer;
    sourceName: string | null;
    mode: string;
    label: string;
    fields: InvoiceFields;
    checks: CheckResult[];
    allChecksPassed: boolean;
    costUsd: number | null;
  }): InvoiceRecord {
    const id = randomUUID();
    writeFileSync(path.join(this.inboxDir, `${id}.pdf`), input.pdf);
    this.db
      .prepare(
        `INSERT INTO invoices (id, status, source_name, extraction_mode, extraction_label, vendor_key, invoice_number,
           fields_json, checks_json, all_checks_passed, cost_usd, created_at)
         VALUES (?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceName,
        input.mode,
        input.label,
        vendorKey(input.fields.vendor_name),
        input.fields.invoice_number,
        JSON.stringify(input.fields),
        JSON.stringify(input.checks),
        input.allChecksPassed ? 1 : 0,
        input.costUsd,
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): InvoiceRecord | null {
    const row = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  list(status?: InvoiceStatus): InvoiceRecord[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM invoices WHERE status = ? ORDER BY created_at").all(status)
        : this.db.prepare("SELECT * FROM invoices ORDER BY created_at").all()
    ) as Row[];
    return rows.map(toRecord);
  }

  /**
   * The only path to "filed". Requires a named approver. If any check failed, the
   * approver must also give an override reason, which is stored with the record.
   * A repeat of an approval already recorded for the same approver is a no-op (so a
   * retried HTTP call is not an error); any other decision on a decided invoice is refused.
   */
  approve(id: string, approver: string, via: string, note?: string, overrideReason?: string): InvoiceRecord {
    if (!approver.trim()) throw new ApprovalError("approver is required");
    const already = this.get(id);
    if (already?.status === "approved" && already.decided_by === approver) return already;
    const rec = this.requirePending(id);
    if (!rec.all_checks_passed && !overrideReason?.trim()) {
      const failed = rec.checks.filter((c) => !c.passed).map((c) => c.name);
      throw new ApprovalError(`checks failed (${failed.join(", ")}); approving needs an override_reason`);
    }
    const dir = path.join(this.filedDir, safeSegment(vendorKey(rec.fields.vendor_name)));
    mkdirSync(dir, { recursive: true });
    let base = path.join(dir, safeSegment(rec.fields.invoice_number));
    // A duplicate approved with an override is filed beside the first copy, never over it.
    if (existsSync(`${base}.json`) || existsSync(`${base}.pdf`)) base += `.${id.slice(0, 8)}`;
    copyFileSync(path.join(this.inboxDir, `${id}.pdf`), `${base}.pdf`);
    const decidedAt = new Date().toISOString();
    const decisionNote = [note, overrideReason ? `override: ${overrideReason}` : null].filter(Boolean).join(" | ") || null;
    writeFileSync(
      `${base}.json`,
      JSON.stringify({ ...rec, status: "approved", decided_by: approver, decided_via: via, decided_at: decidedAt, decision_note: decisionNote }, null, 2),
    );
    this.db
      .prepare(
        "UPDATE invoices SET status='approved', decided_by=?, decided_via=?, decided_at=?, decision_note=?, filed_path=? WHERE id=? AND status='pending_approval'",
      )
      .run(approver, via, decidedAt, decisionNote, `${base}.json`, id);
    return this.get(id)!;
  }

  reject(id: string, approver: string, via: string, reason: string): InvoiceRecord {
    this.requirePending(id);
    if (!approver.trim()) throw new ApprovalError("approver is required");
    if (!reason.trim()) throw new ApprovalError("reason is required");
    this.db
      .prepare("UPDATE invoices SET status='rejected', decided_by=?, decided_via=?, decided_at=?, decision_note=? WHERE id=? AND status='pending_approval'")
      .run(approver, via, new Date().toISOString(), reason, id);
    return this.get(id)!;
  }

  private requirePending(id: string): InvoiceRecord {
    const rec = this.get(id);
    if (!rec) throw new ApprovalError(`no invoice with id ${id}`);
    if (rec.status !== "pending_approval") throw new ApprovalError(`invoice ${id} is already ${rec.status}`);
    return rec;
  }
}

function toRecord(r: Row): InvoiceRecord {
  return {
    id: r.id,
    status: r.status,
    source_name: r.source_name,
    extraction_mode: r.extraction_mode,
    extraction_label: r.extraction_label,
    fields: JSON.parse(r.fields_json),
    checks: JSON.parse(r.checks_json),
    all_checks_passed: r.all_checks_passed === 1,
    cost_usd: r.cost_usd,
    created_at: r.created_at,
    decided_by: r.decided_by,
    decided_via: r.decided_via,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    filed_path: r.filed_path,
  };
}
