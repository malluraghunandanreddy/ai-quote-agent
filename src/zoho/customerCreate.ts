import { nameKey } from '../excel/normalizer';
import type { CustomerDraft } from '../llm/customerExtractor';
import { errorMessage } from '../logger';
import type { ZohoApi } from '../types';

/**
 * Adding a customer to Zoho Books after a person has reviewed and approved the details. Only ever called from the
 * "Add to Zoho Books" button, never by the automatic processing of emails.
 */

/** Zoho's Place of Supply codes for the states we are sure of; a GST number's first two digits name the state. */
const GST_NUMBER_TO_PLACE: Record<string, string> = { '37': 'AP', '36': 'TS', '29': 'KA', '33': 'TN', '27': 'MH', '07': 'DL', '24': 'GJ', '32': 'KL', '19': 'WB', '09': 'UP', '08': 'RJ' };
const STATE_TO_PLACE: Record<string, string> = { 'andhra pradesh': 'AP', telangana: 'TS', karnataka: 'KA', 'tamil nadu': 'TN', maharashtra: 'MH', delhi: 'DL', gujarat: 'GJ', kerala: 'KL', 'west bengal': 'WB', 'uttar pradesh': 'UP', rajasthan: 'RJ' };

/** Where the customer is, for GST: from the GST number if there is one, else from the state. Undefined when unsure. */
export function placeOfSupply(d: Pick<CustomerDraft, 'gstin' | 'state'>): string | undefined {
  return (d.gstin ? GST_NUMBER_TO_PLACE[d.gstin.slice(0, 2)] : undefined) ?? STATE_TO_PLACE[d.state.trim().toLowerCase()];
}

export interface ApprovedCustomer extends Omit<CustomerDraft, 'source'> {}

export function customerPayload(c: ApprovedCustomer, opts: { gstOrg: boolean; note?: string }): Record<string, unknown> {
  const space = c.contactName.trim().lastIndexOf(' ');
  const first = space > 0 ? c.contactName.trim().slice(0, space) : c.contactName.trim();
  const last = space > 0 ? c.contactName.trim().slice(space + 1) : '';
  const address = { ...(c.address ? { address: c.address } : {}), ...(c.city ? { city: c.city } : {}), ...(c.state ? { state: c.state } : {}), ...(c.zip ? { zip: c.zip } : {}), country: 'India' };
  const person = { ...(first ? { first_name: first } : { first_name: c.companyName.slice(0, 30) }), ...(last ? { last_name: last } : {}), ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}), is_primary_contact: true };
  const place = placeOfSupply(c);
  return {
    contact_name: c.companyName,
    company_name: c.companyName,
    contact_type: 'customer',
    customer_sub_type: 'business',
    billing_address: address,
    contact_persons: [person],
    ...(opts.note ? { notes: opts.note.slice(0, 500) } : {}),
    // Only GST-registered organisations have (and require) these.
    ...(opts.gstOrg ? { gst_treatment: c.gstin ? 'business_gst' : 'business_none', ...(c.gstin ? { gst_no: c.gstin } : {}), ...(place ? { place_of_contact: place } : {}) } : {}),
  };
}

export type AddResult = { status: 'created'; name: string } | { status: 'exists'; name: string } | { status: 'failed'; message: string };

/** Is this Zoho organisation GST-registered? Asked once; any doubt means "no", and Zoho's own error says if that was wrong. */
export async function usesGst(zoho: ZohoApi, organizationId: string): Promise<boolean> {
  try {
    const r = await zoho.get<{ organization?: { is_registered_for_gst?: boolean } }>(`/organizations/${organizationId}`);
    return r.organization?.is_registered_for_gst === true;
  } catch {
    return false;
  }
}

export async function addCustomer(zoho: ZohoApi, organizationId: string, customer: ApprovedCustomer, note: string): Promise<AddResult> {
  try {
    // The person may have clicked twice, or someone may have added the customer meanwhile: never make a duplicate.
    const existing = (await zoho.getAllPages<Record<string, unknown>>('/contacts', 'contacts')).find(
      (c) => nameKey(String(c.contact_name ?? '')) === nameKey(customer.companyName) || nameKey(String(c.company_name ?? '')) === nameKey(customer.companyName) || (customer.email !== '' && String(c.email ?? '').toLowerCase() === customer.email.toLowerCase()),
    );
    if (existing) return { status: 'exists', name: String(existing.contact_name ?? customer.companyName) };
    await zoho.post('/contacts', customerPayload(customer, { gstOrg: await usesGst(zoho, organizationId), note }));
    return { status: 'created', name: customer.companyName };
  } catch (err) {
    const message = errorMessage(err);
    const gst = /gst|place of (supply|contact)/i.test(message);
    return { status: 'failed', message: `${message.slice(0, 240)}${gst ? ' This Zoho organisation uses GST: add this customer in Zoho Books by hand, with its state and GST number.' : ''}` };
  }
}
