import type { ZohoApi, ZohoContact, ZohoItem } from '../src/types';

/**
 * In-memory stand-in for the slice of Zoho Books API v3 this agent uses. Used by the mock run and the unit tests
 * so the whole pipeline can be exercised without credentials. It mimics the behaviour the agent relies on:
 *  - list results carry fewer fields than the contact detail record;
 *  - estimates are created as drafts, priced from the item master, and taxed at 18% (CGST+SGST or IGST);
 *  - unlinked lines keep the rate sent (0.00).
 */

export interface FakeEstimate {
  estimate_id: string;
  estimate_number: string;
  status: string;
  reference_number: string;
  customer_id: string;
  total: number;
  currency_code: string;
  line_items: Array<{ item_id: string; name: string; rate: number; quantity: number }>;
  request: Record<string, unknown>;
}

type Params = Record<string, string | number | boolean | undefined>;

export class FakeZoho implements ZohoApi {
  readonly estimates: FakeEstimate[] = [];
  readonly calls: string[] = [];
  /** Set to make the next POST /estimates fail like a Zoho outage. */
  failNextCreate: Error | null = null;
  /** Whether the stand-in org is GST-registered (drives the "no Place of Supply" warning). */
  gstRegistered = true;

  constructor(
    private readonly contacts: ZohoContact[],
    private readonly items: ZohoItem[],
  ) {}

  async get<T = unknown>(path: string, params: Params = {}): Promise<T> {
    this.calls.push(`GET ${path} ${JSON.stringify(params)}`);

    if (/^\/organizations\/.+$/.test(path)) {
      return { code: 0, organization: { is_registered_for_gst: this.gstRegistered } } as T;
    }
    if (path === '/contacts') {
      const email = typeof params.email === 'string' ? params.email.toLowerCase() : undefined;
      const contains = typeof params.company_name_contains === 'string' ? params.company_name_contains.toLowerCase() : undefined;
      const rows = this.contacts
        .filter((c) => (email === undefined ? true : c.email?.toLowerCase() === email))
        .filter((c) => (contains === undefined ? true : (c.company_name ?? '').toLowerCase().includes(contains)))
        // list view: no place of supply / GST fields
        .map(({ contact_id, contact_name, company_name, email: e, status, contact_type }) => ({
          contact_id,
          contact_name,
          ...(company_name ? { company_name } : {}),
          ...(e ? { email: e } : {}),
          ...(status ? { status } : {}),
          ...(contact_type ? { contact_type } : {}),
        }));
      return { code: 0, contacts: rows } as T;
    }
    const contact = /^\/contacts\/(.+)$/.exec(path);
    if (contact) {
      const found = this.contacts.find((c) => c.contact_id === contact[1]);
      if (!found) throw new Error(`FakeZoho: no contact ${contact[1]}`);
      return { code: 0, contact: found } as T;
    }
    if (path === '/estimates') {
      const ref = params.reference_number;
      const hits = this.estimates.filter((e) => e.reference_number === ref);
      return { code: 0, estimates: hits.map((e) => ({ estimate_id: e.estimate_id, reference_number: e.reference_number })) } as T;
    }
    const estimate = /^\/estimates\/(.+)$/.exec(path);
    if (estimate) {
      const found = this.estimates.find((e) => e.estimate_id === estimate[1]);
      if (!found) throw new Error(`FakeZoho: no estimate ${estimate[1]}`);
      const { request: _request, ...rest } = found;
      return { code: 0, estimate: rest } as T;
    }
    throw new Error(`FakeZoho: unhandled GET ${path}`);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    this.calls.push(`POST ${path}`);
    if (path !== '/estimates') throw new Error(`FakeZoho: unhandled POST ${path}`);
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }

    const req = body as {
      customer_id: string;
      reference_number: string;
      line_items: Array<{ item_id?: string; name?: string; quantity: number; rate?: number }>;
    };
    if (!this.contacts.some((c) => c.contact_id === req.customer_id)) throw new Error('FakeZoho: unknown customer_id');

    const lineItems = req.line_items.map((li) => {
      const item = li.item_id ? this.items.find((i) => i.item_id === li.item_id) : undefined;
      if (li.item_id && !item) throw new Error(`FakeZoho: unknown item_id ${li.item_id}`);
      return {
        item_id: item?.item_id ?? '',
        name: item?.name ?? li.name ?? '',
        rate: li.rate ?? item?.rate ?? 0,
        quantity: li.quantity,
      };
    });
    const subtotal = lineItems.reduce((sum, li) => sum + li.rate * li.quantity, 0);
    const n = this.estimates.length + 1;
    const created: FakeEstimate = {
      estimate_id: `EST-ID-${String(n).padStart(4, '0')}`,
      estimate_number: `EST-${String(n).padStart(6, '0')}`,
      status: 'draft',
      reference_number: req.reference_number,
      customer_id: req.customer_id,
      total: Math.round(subtotal * 1.18 * 100) / 100,
      currency_code: 'INR',
      line_items: lineItems,
      request: body as Record<string, unknown>,
    };
    this.estimates.push(created);
    const { request: _request, ...rest } = created;
    return { code: 0, message: 'The estimate has been created.', estimate: rest } as T;
  }

  async getAllPages<T = unknown>(path: string, key: string, params: Params = {}): Promise<T[]> {
    if (path === '/contacts' && key === 'contacts') {
      return ((await this.get<{ contacts: T[] }>(path, params)).contacts);
    }
    this.calls.push(`GET(all) ${path}`);
    if (path === '/items' && key === 'items') return this.items as unknown as T[];
    throw new Error(`FakeZoho: unhandled list ${path}`);
  }
}
