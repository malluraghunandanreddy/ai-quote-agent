import { z } from 'zod';
import type { ZohoConfig } from '../config';
import type { CreatedEstimate, EstimateLineItem, MatchedLine, ZohoApi, ZohoContact } from '../types';
import { ZohoApiError } from './client';

/**
 * Quotations are Zoho Books "estimates". This module only ever CREATES them, and Zoho creates them as drafts.
 * It never calls the "mark as sent" / "email" endpoints, and it verifies the status Zoho reports back.
 */

export const UNMATCHED_MARKER = '[UNMATCHED ITEM - MANUAL PRICING REQUIRED]';
const NAME_LIMIT = 100;

const LineItemResponse = z.looseObject({
  item_id: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
  rate: z.coerce.number().default(0),
  quantity: z.coerce.number().default(0),
});

const EstimateResponse = z.looseObject({
  estimate: z.looseObject({
    estimate_id: z.union([z.string(), z.number()]),
    estimate_number: z.string(),
    status: z.string(),
    total: z.coerce.number().default(0),
    currency_code: z.string().default(''),
    line_items: z.array(LineItemResponse).default([]),
  }),
});

const EstimateListResponse = z.looseObject({
  estimates: z
    .array(z.looseObject({ estimate_id: z.union([z.string(), z.number()]), reference_number: z.string().nullish() }))
    .default([]),
});

// --- dates -------------------------------------------------------------------------------------

/** YYYY-MM-DD for the instant, in the given IANA timezone (Zoho dates are calendar dates in the org's zone). */
export function calendarDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// --- payload -----------------------------------------------------------------------------------

export interface EstimatePayloadInput {
  customer: ZohoContact;
  lines: MatchedLine[];
  /** Stable per-enquiry reference, used to find the estimate again if a response was lost. */
  reference: string;
  notes: string | null;
  validityDays: number;
  timezone: string;
  sendItemRate: boolean;
  now: Date;
}

export interface EstimatePayload {
  body: Record<string, unknown>;
  date: string;
  expiryDate: string;
  lineItems: EstimateLineItem[];
}

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Pure: builds the request body. Taxes are deliberately absent; Zoho derives them from the customer's Place of Supply. */
export function buildEstimatePayload(input: EstimatePayloadInput): EstimatePayload {
  const date = calendarDate(input.now, input.timezone);
  const expiryDate = addDays(date, input.validityDays);

  const lineItems: EstimateLineItem[] = input.lines.map(({ line, match }) => {
    if (match.status === 'matched') {
      // Rate left to Zoho (item master / customer price list) unless explicitly configured otherwise.
      return {
        item_id: match.item.item_id,
        name: match.item.name,
        quantity: line.quantity,
        ...(input.sendItemRate && match.item.rate !== undefined ? { rate: match.item.rate } : {}),
      };
    }
    return {
      name: truncate(line.sku ? `${line.sku} - ${line.description}` : line.description, NAME_LIMIT),
      description: UNMATCHED_MARKER,
      quantity: line.quantity,
      rate: 0,
      ...(line.uom ? { unit: line.uom } : {}),
    };
  });

  const customer = input.customer;
  const body: Record<string, unknown> = {
    customer_id: customer.contact_id,
    date,
    expiry_date: expiryDate,
    reference_number: input.reference,
    ...(customer.place_of_contact ? { place_of_supply: customer.place_of_contact } : {}),
    ...(customer.gst_treatment ? { gst_treatment: customer.gst_treatment } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    line_items: lineItems,
  };
  return { body, date, expiryDate, lineItems };
}

// --- Zoho calls --------------------------------------------------------------------------------

function toCreated(parsed: z.infer<typeof EstimateResponse>, reused: boolean): CreatedEstimate {
  const e = parsed.estimate;
  return {
    estimateId: String(e.estimate_id),
    estimateNumber: e.estimate_number,
    status: e.status,
    total: e.total,
    currencyCode: e.currency_code,
    lineItems: e.line_items.map((li) => ({
      itemId: li.item_id ? String(li.item_id) : null,
      name: li.name ?? '',
      rate: li.rate,
      quantity: li.quantity,
    })),
    reused,
  };
}

/** An estimate an earlier attempt already created for this enquiry (e.g. the response was lost), or null. */
export async function findEstimateByReference(api: ZohoApi, reference: string): Promise<CreatedEstimate | null> {
  const list = EstimateListResponse.parse(await api.get('/estimates', { reference_number: reference }));
  const hit = list.estimates.find((e) => e.reference_number === reference);
  if (!hit) return null;
  const full = EstimateResponse.parse(await api.get(`/estimates/${hit.estimate_id}`));
  return toCreated(full, true);
}

/** Create the quotation as a DRAFT. Throws if Zoho reports any other status. */
export async function createDraftEstimate(api: ZohoApi, payload: EstimatePayload): Promise<CreatedEstimate> {
  const raw = await api.post('/estimates', payload.body);
  const parsed = EstimateResponse.safeParse(raw);
  if (!parsed.success) {
    throw new ZohoApiError(`Zoho returned an unexpected estimate response: ${parsed.error.message}`, {
      transient: false,
      outcomeUnknown: true,
    });
  }
  if (parsed.data.estimate.status !== 'draft') {
    throw new ZohoApiError(
      `Zoho created estimate ${parsed.data.estimate.estimate_number} with status "${parsed.data.estimate.status}", expected "draft"`,
      { transient: false },
    );
  }
  return toCreated(parsed.data, false);
}

export function quoteUrl(cfg: ZohoConfig, linkPath: 'quotes' | 'estimates', estimateId: string): string {
  return `${cfg.appBase}/app/${cfg.organizationId}#/${linkPath}/${estimateId}`;
}
