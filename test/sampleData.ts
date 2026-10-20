import type { ZohoContact } from '../src/types';

/**
 * Fictional sample customers (Andhra Pradesh), each messy in a different way. Seeded into Zoho Books by
 * `npm run seed:zoho` and used as the offline stand-in directory by `npm run test:emails`.
 * Every email address is made up; the agent never emails customers.
 */
export interface SampleCustomer {
  contact_name: string;
  company_name: string;
  first: string;
  last: string;
  email: string;
  address: string;
  city: string;
  zip: string;
  tests: string;
}

export const SAMPLE_NOTE = 'SAMPLE record for testing the AI quote agent - safe to delete.';

export const SAMPLE_CUSTOMERS: SampleCustomer[] = [
  { contact_name: 'Acme Industries Pvt Ltd (SAMPLE)', company_name: 'Acme Industries Pvt Ltd (SAMPLE)', first: 'Rajesh', last: 'Kumar', email: 'purchase@acme-industries.co.in', address: 'Plot 14, APIIC Industrial Park', city: 'Visakhapatnam', zip: '530012', tests: 'clean baseline; default sender of npm run test:mock (email match)' },
  { contact_name: 'M/s. SRI VENKATESWARA ELECTRICALS & CONTRACTORS', company_name: 'M/s. SRI VENKATESWARA ELECTRICALS & CONTRACTORS', first: 'S.', last: 'Venkat Rao', email: 'sample.sve.contractors.test@gmail.com', address: 'D.No 12-3-45/A,, Near Old Bus Stand ,', city: 'Vijayawada', zip: '520001', tests: 'ALL CAPS, M/s. prefix, ampersand, free-mail address (email match only)' },
  { contact_name: 'Godavari Power  Tech  (P) Ltd.', company_name: 'Godavari Power  Tech  (P) Ltd.', first: 'Mr. K', last: 'Srinivas Reddy', email: 'accounts@godavaripowertech.in', address: 'Door No. 5-77, Dowleswaram Rd', city: 'Rajahmundry', zip: '533125', tests: 'double spaces, "(P) Ltd." (domain match from another person at godavaripowertech.in)' },
  { contact_name: 'Krishna Delta Steels', company_name: 'KRISHNA DELTA STEEL INDUSTRIES LIMITED', first: 'Purchase', last: 'Dept', email: 'purchase@krishnadeltasteel.co.in', address: 'Survey No 221/2, Gudivada Road', city: 'Machilipatnam', zip: '521001', tests: 'contact name differs from company name; .co.in domain (domain match)' },
  { contact_name: 'Tirumala Cables and Conductors Pvt. Ltd.', company_name: 'Tirumala Cables and Conductors Pvt. Ltd.', first: 'Lakshmi', last: 'Prasanna', email: 'stores@tirumalacables.com', address: 'Plot 9 & 10, Renigunta Industrial Area', city: 'Tirupati', zip: '517520', tests: 'legal suffix with dots; "and" vs "&" (domain match)' },
  { contact_name: 'Sri Sai Engineering Works', company_name: 'Sri Sai Engineering Works', first: 'Sai', last: 'Kumar', email: 'sales@srisaiengineering.in', address: 'Unit 1, Autonagar', city: 'Guntur', zip: '522002', tests: 'AMBIGUOUS pair with the next customer: same domain' },
  { contact_name: 'Sri Sai Engineering Works (Unit 2)', company_name: 'Sri Sai Engineering Works (Unit 2)', first: 'Sai', last: 'Prasad', email: 'unit2@srisaiengineering.in', address: 'Unit 2, Autonagar', city: 'Guntur', zip: '522002', tests: 'AMBIGUOUS pair with the previous customer: same domain' },
  { contact_name: 'Nellore Agro Exports', company_name: 'Nellore Agro Exports', first: 'Anitha', last: 'R', email: 'orders@mail.nelloreagro.com', address: 'Godown 3, Port Road', city: 'Nellore', zip: '524001', tests: 'email on a subdomain (mail.); other staff match via the main domain' },
  { contact_name: 'G. Ramesh Babu (Ramesh Traders)', company_name: 'Ramesh Traders', first: 'G.', last: 'Ramesh Babu', email: 'sample.rameshtraders.test@yahoo.co.in', address: 'Brodipet 4/5,, Main Rd', city: 'Guntur', zip: '522002', tests: 'sole proprietor, personal name in contact name, free-mail address (company-name match from a gmail sender)' },
  { contact_name: 'Kakinada Marine Supplies', company_name: 'Kakinada Marine Supplies', first: 'Dept', last: 'Purchase', email: 'Purchase.Dept@KakinadaMarine.COM', address: 'Fishing Harbour Rd', city: 'Kakinada', zip: '533003', tests: 'mixed-case email address (case-insensitive match)' },
  { contact_name: 'Anantha Solar & Allied Services LLP', company_name: 'Anantha Solar & Allied Services LLP', first: 'Meena', last: 'Devi', email: 'procurement+rfq@ananthasolar.in', address: '#7, 2nd Cross,, Opp. RTC Complex', city: 'Anantapur', zip: '515001', tests: 'plus-addressing, LLP, ampersand (domain match from a different address)' },
  { contact_name: ' Rayalaseema   Textile Mills  Ltd. ', company_name: ' Rayalaseema   Textile Mills  Ltd. ', first: 'Mohd', last: 'Rafi', email: 'info@rayalaseematextiles.com', address: 'Kurnool-Nandyal Hwy,,', city: 'Kurnool', zip: '518002', tests: 'stray spaces; domain says "textiles" but name says "Textile Mills" (domain misses, company-name match works)' },
];

/** The same customers as Zoho would list them (offline stand-in). */
export function fakeContacts(): ZohoContact[] {
  return SAMPLE_CUSTOMERS.map((c, i) => ({
    contact_id: `SAMPLE-${String(i + 1).padStart(3, '0')}`,
    contact_name: c.contact_name,
    company_name: c.company_name,
    email: c.email,
    status: 'active',
    contact_type: 'customer',
  }));
}
