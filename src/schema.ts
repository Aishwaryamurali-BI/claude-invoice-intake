// The shape Claude must return for one invoice, written once as a zod schema.
// The same schema is (1) sent to the API as a structured-output JSON schema and
// (2) used to validate the reply, so the model and our code can't drift apart.
//
// Structured outputs ignore numeric/string constraints (min, max, length), so the
// schema stays plain and the real rules live in src/checks.ts.
//
// Found by inspecting the request (tests/wire.test.ts): this SDK version's helper
// (betaZodOutputFormat in @anthropic-ai/sdk 0.131) moves `enum` into the field's
// description text instead of sending it as a JSON-schema enum. So the API sees
// document_type / sources[].field as plain strings with a hint, and the zod parse
// after the response is what actually enforces the allowed values.
import { z } from "zod/v4";

/** Fields that must carry a source citation (page + verbatim quote). */
export const KEY_FIELDS = [
  "vendor_name",
  "invoice_number",
  "issue_date",
  "due_date",
  "currency",
  "po_number",
  "subtotal",
  "tax",
  "total",
] as const;
export type KeyField = (typeof KEY_FIELDS)[number];

export const SourceSchema = z.object({
  field: z.enum(KEY_FIELDS),
  page: z.number().int().describe("1-based page number in the PDF where the value appears"),
  quote: z
    .string()
    .describe("Short verbatim text copied from that page that shows the value, under 20 words"),
});

export const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  amount: z.number().describe("Line total as printed on the document"),
});

export const InvoiceFieldsSchema = z.object({
  document_type: z.enum(["invoice", "credit_note"]),
  vendor_name: z.string().describe("The issuer of the document (who is to be paid or who is crediting)"),
  invoice_number: z.string().describe("The document's own number, exactly as printed"),
  issue_date: z.string().describe("YYYY-MM-DD"),
  due_date: z.string().nullable().describe("YYYY-MM-DD, or null if the document gives no due date"),
  currency: z.string().describe("ISO 4217 code, e.g. USD, EUR, GBP, JPY"),
  po_number: z.string().nullable().describe("Buyer's purchase order number, or null if none is printed"),
  line_items: z.array(LineItemSchema),
  subtotal: z.number().describe("Amount before tax, as printed"),
  tax: z.number().describe("Total tax, as printed; 0 if none"),
  total: z.number().describe("Grand total, as printed"),
  sources: z.array(SourceSchema),
});

export type InvoiceFields = z.infer<typeof InvoiceFieldsSchema>;
export type Source = z.infer<typeof SourceSchema>;
