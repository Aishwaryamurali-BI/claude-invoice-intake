// Weekly payables forecast: what falls due in each of the next N weeks.
//
// - Approved invoices are "committed"; pending ones are shown separately because a
//   human hasn't said yes yet. Rejected ones are ignored.
// - Credit notes reduce the week they fall in (or the overdue bucket).
// - Amounts are grouped per currency. No FX conversion: a made-up rate would be a
//   made-up number.
import type { InvoiceRecord } from "./store.js";

export interface ForecastBucket {
  label: string;
  start: string | null; // inclusive, YYYY-MM-DD
  end: string | null; // inclusive
  committed: Record<string, number>; // currency -> amount
  pending: Record<string, number>;
  invoices: { id: string; vendor: string; invoice_number: string; due_date: string; amount: number; currency: string; status: string }[];
}

export interface Forecast {
  as_of: string;
  weeks: number;
  buckets: ForecastBucket[]; // [overdue, week 1..N]
  no_due_date: { id: string; vendor: string; invoice_number: string }[];
}

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function payablesForecast(records: InvoiceRecord[], asOf: string, weeks = 4): Forecast {
  const buckets: ForecastBucket[] = [
    { label: "overdue", start: null, end: addDays(asOf, -1), committed: {}, pending: {}, invoices: [] },
  ];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(asOf, w * 7);
    buckets.push({ label: `week ${w + 1}`, start, end: addDays(start, 6), committed: {}, pending: {}, invoices: [] });
  }
  const horizonEnd = buckets[buckets.length - 1]!.end!;
  const noDue: Forecast["no_due_date"] = [];

  for (const rec of records) {
    if (rec.status === "rejected") continue;
    const f = rec.fields;
    if (!f.due_date) {
      noDue.push({ id: rec.id, vendor: f.vendor_name, invoice_number: f.invoice_number });
      continue;
    }
    if (f.due_date > horizonEnd) continue;
    const bucket = f.due_date < asOf ? buckets[0]! : buckets.find((b) => b.start !== null && f.due_date! >= b.start && f.due_date! <= b.end!)!;
    const signed = f.document_type === "credit_note" ? -f.total : f.total;
    const target = rec.status === "approved" ? bucket.committed : bucket.pending;
    target[f.currency] = r2((target[f.currency] ?? 0) + signed);
    bucket.invoices.push({
      id: rec.id,
      vendor: f.vendor_name,
      invoice_number: f.invoice_number,
      due_date: f.due_date,
      amount: signed,
      currency: f.currency,
      status: rec.status,
    });
  }
  return { as_of: asOf, weeks, buckets, no_due_date: noDue };
}
