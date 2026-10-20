import { nameKey } from '../excel/normalizer';
import { logger } from '../logger';
import type { CustomerMatchTier, CustomerResolution, ZohoApi, ZohoContact } from '../types';

/**
 * Three-tier customer resolution. Customers are NEVER created here: if nothing fits, the caller halts and asks
 * Sales to create the customer master (with GSTIN / PAN).
 *   1. exact sender email            /contacts?email=                           (always asked live)
 *   2. corporate email domain        matched against the active-customer list   (free-mail domains skipped)
 *   3. company name from the email   matched against the active-customer list
 * Tiers 2 and 3 compare in code against a cached list of active customers rather than using Zoho's substring
 * search: company names carry spaces and punctuation ("Sri Sai Engineering" vs the domain srisaiengineering.in),
 * so no fixed search term is safe, and one list fetch serves many enquiries.
 */

export interface CustomerLookup {
  senderEmail: string;
  companyName: string | null;
}

export interface CustomerLookupResult {
  resolution: CustomerResolution;
  /** Human-readable account of each lookup, used in the "customer not found" email. */
  tried: string[];
}

const DIRECTORY_TTL_MS = 10 * 60_000;
/** A miss may reload the list, but at most this often, so a burst of unknown senders cannot hammer Zoho. */
const MIN_REFRESH_MS = 60_000;

/** Second-level labels used under country TLDs (acme.co.in, acme.com.au, acme.ac.uk ...). */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'nic', 'res', 'ltd', 'plc']);
const LEGAL_WORDS = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'the', 'and', 'india', 'opc', 'p',
]);

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();
}

/** acme.co.in -> "acme", mail.acme.com -> "acme", acme-industries.com -> "acme-industries". */
export function domainStem(domain: string): string {
  let labels = domain.toLowerCase().split('.').filter(Boolean);
  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  if (labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(second)) labels = labels.slice(0, -2);
  else labels = labels.slice(0, -1);
  return labels[labels.length - 1] ?? '';
}

/** "M/s. Sri Sai Traders" -> "Sri Sai Traders" (the Indian "Messrs" prefix says nothing about the company). */
const withoutMessrs = (name: string): string => name.replace(/^\s*m\s*\/\s*s\.?\s+/i, '');

const significantTokens = (name: string): string[] =>
  nameKey(withoutMessrs(name)).split(' ').filter((t) => t !== '' && !LEGAL_WORDS.has(t));

const displayName = (c: ZohoContact): string => (c.company_name || c.contact_name || '').replace(/\s+/g, ' ').trim();

const isUsableCustomer = (c: ZohoContact): boolean =>
  (c.contact_type === undefined || c.contact_type === 'customer') && (c.status === undefined || c.status === 'active');

function distinct(contacts: ZohoContact[]): ZohoContact[] {
  return [...new Map(contacts.map((c) => [c.contact_id, c])).values()];
}

/** A company matches a domain stem when its leading words spell the stem ("acme" ~ "Acme Industries"). */
function matchesStem(company: string, stem: string): boolean {
  const tokens = nameKey(withoutMessrs(company)).split(' ').filter(Boolean);
  while (tokens[0] === 'the') tokens.shift();
  const target = nameKey(stem).replace(/ /g, '');
  if (target.length < 3) return false;
  let joined = '';
  for (const t of tokens) {
    joined += t;
    if (joined === target) return true;
    if (joined.length >= target.length) return false;
  }
  return false;
}

/** Cached list of active customers (refreshed every few minutes, or once on a miss). */
export class CustomerDirectory {
  private rows: ZohoContact[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly api: ZohoApi,
    private readonly clock: () => number = Date.now,
  ) {}

  private age(): number {
    return this.loadedAt === 0 ? Infinity : this.clock() - this.loadedAt;
  }

  /** True when a reload would be allowed right now (the copy is old enough). */
  canRefresh(): boolean {
    return this.age() >= MIN_REFRESH_MS;
  }

  async customers(): Promise<ZohoContact[]> {
    if (this.age() >= DIRECTORY_TTL_MS) await this.reload();
    return this.rows;
  }

  async reload(): Promise<ZohoContact[]> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
    return this.rows;
  }

  private async load(): Promise<void> {
    const all = await this.api.getAllPages<ZohoContact>('/contacts', 'contacts', { filter_by: 'Status.Active' });
    this.rows = all.filter(isUsableCustomer);
    this.loadedAt = this.clock();
    logger.info('Zoho customer list loaded', { activeCustomers: this.rows.length });
  }
}

/** Fetch the full contact record: Place of Supply, GST treatment and currency are not in list results. */
async function withDetails(api: ZohoApi, contact: ZohoContact): Promise<ZohoContact> {
  try {
    const res = await api.get<{ contact?: ZohoContact }>(`/contacts/${contact.contact_id}`);
    return { ...contact, ...(res.contact ?? {}) };
  } catch (err) {
    logger.warn('Could not load customer details; continuing with list data', {
      contactId: contact.contact_id,
      error: (err as Error).message,
    });
    return contact;
  }
}

type Match =
  | { kind: 'found'; tier: CustomerMatchTier; confidence: 'exact' | 'probable'; contact: ZohoContact }
  | { kind: 'ambiguous'; tier: CustomerMatchTier; candidates: ZohoContact[] }
  | { kind: 'none' };

/** Tiers 2 and 3 against a customer list. Pure; `notes` collects what was tried. */
function matchDirectory(pool: ZohoContact[], input: CustomerLookup, publicDomains: ReadonlySet<string>, notes: string[]): Match {
  // Tier 2: corporate domain (never for free-mail domains)
  let domainCandidates: ZohoContact[] = [];
  const domain = emailDomain(input.senderEmail);
  if (publicDomains.has(domain)) {
    notes.push(`Email domain "${domain}": skipped (public mail provider)`);
  } else {
    const stem = domainStem(domain);
    if (stem.replace(/[^a-z0-9]/g, '').length < 3) {
      notes.push(`Email domain "${domain}": skipped (too short to match safely)`);
    } else {
      const hits = distinct(pool.filter((c) => matchesStem(displayName(c), stem)));
      const outcome =
        hits.length === 0 ? 'no customer' : hits.length === 1 ? `matched ${displayName(hits[0] as ZohoContact)}` : `${hits.length} customers (ambiguous)`;
      notes.push(`Email domain "${domain}" (company "${stem}"): ${outcome}`);
      if (hits.length === 1 && hits[0]) return { kind: 'found', tier: 'domain', confidence: 'probable', contact: hits[0] };
      if (hits.length > 1) domainCandidates = hits;
    }
  }

  // Tier 3: company name written in the email
  if (input.companyName) {
    const wanted = significantTokens(input.companyName);
    const wantedKey = wanted.join(' ');
    if (wantedKey.replace(/ /g, '').length < 3) {
      notes.push(`Company name "${input.companyName}": too generic to search`);
    } else {
      const equal = pool.filter((c) => significantTokens(displayName(c)).join(' ') === wantedKey);
      const superset = pool.filter((c) => {
        const have = new Set(significantTokens(displayName(c)));
        return wanted.every((t) => have.has(t));
      });
      const best = distinct(equal.length > 0 ? equal : superset);
      if (best.length === 1 && best[0]) {
        notes.push(`Company name "${input.companyName}": matched ${displayName(best[0])}`);
        return { kind: 'found', tier: 'company_name', confidence: equal.length > 0 ? 'exact' : 'probable', contact: best[0] };
      }
      if (best.length > 1) {
        notes.push(`Company name "${input.companyName}": ${best.length} customers (ambiguous)`);
        return { kind: 'ambiguous', tier: 'company_name', candidates: best };
      }
      notes.push(`Company name "${input.companyName}": no customer`);
    }
  } else {
    notes.push('Company name: none could be read from the email');
  }

  if (domainCandidates.length > 1) return { kind: 'ambiguous', tier: 'domain', candidates: domainCandidates };
  return { kind: 'none' };
}

export async function resolveCustomer(
  api: ZohoApi,
  input: CustomerLookup,
  publicDomains: ReadonlySet<string>,
  directory: CustomerDirectory = new CustomerDirectory(api),
): Promise<CustomerLookupResult> {
  const tried: string[] = [];
  const email = input.senderEmail.trim().toLowerCase();

  // Tier 1: exact sender email, asked live (cheap, and always current)
  const res = await api.get<{ contacts?: ZohoContact[] }>('/contacts', { email });
  const byEmail = distinct((res.contacts ?? []).filter(isUsableCustomer));
  const exactEmail = byEmail.filter((c) => c.email?.toLowerCase() === email);
  const single = byEmail.length === 1 ? byEmail[0] : exactEmail.length === 1 ? exactEmail[0] : undefined;
  if (single) {
    tried.push(`Sender email "${email}": matched ${displayName(single)}`);
    return { resolution: { status: 'found', tier: 'email', confidence: 'exact', contact: await withDetails(api, single) }, tried };
  }
  if (byEmail.length > 1) {
    tried.push(`Sender email "${email}": ${byEmail.length} customers share it`);
    return { resolution: { status: 'ambiguous', tier: 'email', candidates: byEmail }, tried };
  }
  tried.push(`Sender email "${email}": no active customer`);

  // Tiers 2 and 3. On a miss, reload the customer list once (if the copy is old enough) so a customer that was
  // created a few minutes ago is not reported as unknown.
  let notes: string[] = [];
  let match = matchDirectory(await directory.customers(), input, publicDomains, notes);
  if (match.kind === 'none' && directory.canRefresh()) {
    notes = [];
    match = matchDirectory(await directory.reload(), input, publicDomains, notes);
  }
  tried.push(...notes);

  if (match.kind === 'found') {
    return {
      resolution: { status: 'found', tier: match.tier, confidence: match.confidence, contact: await withDetails(api, match.contact) },
      tried,
    };
  }
  if (match.kind === 'ambiguous') {
    return { resolution: { status: 'ambiguous', tier: match.tier, candidates: match.candidates }, tried };
  }
  return { resolution: { status: 'not_found' }, tried };
}
