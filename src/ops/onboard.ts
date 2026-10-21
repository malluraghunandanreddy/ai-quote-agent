import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { getConfig, requireZoho } from '../config';
import { nameKey } from '../excel/normalizer';
import { errorMessage } from '../logger';
import { ZohoClient } from '../zoho/client';

/**
 * Client onboarding in one step: the client fills in a small Excel form (their company and the items they usually
 * quote), and this adds them to Zoho Books so their first email can become a complete, priced draft.
 *
 *   npm run onboard:template                 write client-onboarding-template.xlsx to send to the client
 *   npm run onboard -- their-file.xlsx       preview only: shows what would be created, changes nothing
 *   npm run onboard -- their-file.xlsx --create   really create the customer and items in Zoho Books
 *
 * This is a deliberate, one-off step run by you. The quote assistant itself never creates customers or items from
 * incoming emails (a spam or fake email could otherwise fill Zoho Books with junk).
 */

export interface CompanyInput {
  name: string;
  contact: string;
  email: string;
  city: string;
}
export interface ItemInput {
  name: string;
  code: string;
  unit: string;
  price: number;
  description: string;
}
export interface Parsed {
  companies: CompanyInput[];
  items: ItemInput[];
  problems: string[];
}

const NAME_LIMIT = 100;

// --- the form ------------------------------------------------------------------------------------------------------

export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const help = wb.addWorksheet('Read me');
  for (const line of [
    'Quote assistant: setup form',
    '',
    'Please fill in the two sheets and send the file back.',
    '1. Company: your company name exactly as you write it at the bottom of your emails, plus a contact person and email.',
    '2. Items: 3 to 5 items you often quote. Use the same names (and codes, if you use them) as in your own Excel lists.',
    '   Selling price is in rupees, per unit. An approximate price is fine for the demo.',
    'Delete the grey example rows, or leave them: they are ignored.',
  ]) help.addRow([line]);
  help.getRow(1).font = { bold: true, size: 14 };
  help.getColumn(1).width = 110;

  const company = wb.addWorksheet('Company');
  company.addRow(['Company name', 'Contact person', 'Email', 'City']);
  company.addRow(['Example: Sri Lakshmi Traders Pvt Ltd', 'Example: Ravi Kumar', 'ravi@srilakshmi.example', 'Guntur']);
  company.addRow(['', '', '', '']);
  company.columns = [{ width: 42 }, { width: 24 }, { width: 32 }, { width: 18 }];

  const items = wb.addWorksheet('Items');
  items.addRow(['Item name', 'Item code', 'Unit', 'Selling price', 'Description']);
  items.addRow(['Example: Hex bolt M12 x 60 SS304', 'HB-1260', 'pcs', 12.5, '']);
  for (let i = 0; i < 5; i++) items.addRow(['', '', '', '', '']);
  items.columns = [{ width: 44 }, { width: 16 }, { width: 10 }, { width: 16 }, { width: 36 }];

  for (const ws of [company, items]) {
    ws.getRow(1).font = { bold: true };
    ws.getRow(2).font = { italic: true, color: { argb: 'FF888888' } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- reading the filled-in form ---------------------------------------------------------------------------------------

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('text' in o) return String(o.text).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/** "₹1,250.50", "Rs 1250", "1250" -> number; anything else -> NaN. */
export function parsePrice(raw: string): number {
  const cleaned = raw.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

const isExample = (s: string): boolean => /^example\b/i.test(s);
const stripExample = (s: string): string => s.replace(/^example:?\s*/i, '');

function sheetRows(ws: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => rows.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellText)));
  return rows;
}

function columns(header: string[], wanted: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  header.forEach((h, i) => {
    const k = h.toLowerCase().replace(/[^a-z ]/g, '').trim();
    for (const [field, names] of Object.entries(wanted)) if (names.includes(k) && out[field] === undefined) out[field] = i;
  });
  return out;
}

export async function parseOnboarding(buffer: Buffer): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const problems: string[] = [];
  const sheet = (name: string): ExcelJS.Worksheet | undefined => wb.worksheets.find((w) => w.name.trim().toLowerCase() === name);

  const companies: CompanyInput[] = [];
  const cs = sheet('company');
  if (!cs) problems.push('The sheet "Company" is missing.');
  else {
    const rows = sheetRows(cs);
    const hi = rows.findIndex((r) => r.some((c) => /^company( name)?$/i.test(c)));
    const col = hi >= 0 ? columns(rows[hi] as string[], { name: ['company name', 'company', 'customer name', 'name'], contact: ['contact person', 'contact', 'contact name'], email: ['email', 'email address', 'email id'], city: ['city'] }) : {};
    if (hi < 0 || col.name === undefined) problems.push('The "Company" sheet needs a column called "Company name".');
    else {
      for (const r of rows.slice(hi + 1)) {
        const name = r[col.name as number] ?? '';
        if (!name || isExample(name)) continue;
        const email = (col.email !== undefined ? r[col.email] : '') ?? '';
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push(`Company "${name}": "${email}" is not a valid email address.`);
        companies.push({ name: name.replace(/\s+/g, ' '), contact: (col.contact !== undefined ? r[col.contact] : '') ?? '', email, city: (col.city !== undefined ? r[col.city] : '') ?? '' });
      }
    }
  }
  if (companies.length === 0 && !problems.some((p) => p.includes('Company'))) problems.push('No company was filled in on the "Company" sheet.');

  const items: ItemInput[] = [];
  const is = sheet('items');
  if (!is) problems.push('The sheet "Items" is missing.');
  else {
    const rows = sheetRows(is);
    const hi = rows.findIndex((r) => r.some((c) => /^item( name)?$/i.test(c)));
    const col = hi >= 0 ? columns(rows[hi] as string[], { name: ['item name', 'item', 'name', 'product'], code: ['item code', 'code', 'sku'], unit: ['unit', 'uom'], price: ['selling price', 'price', 'rate'], description: ['description'] }) : {};
    if (hi < 0 || col.name === undefined) problems.push('The "Items" sheet needs a column called "Item name".');
    else {
      const seen = new Set<string>();
      for (const [n, r] of rows.slice(hi + 1).entries()) {
        const name = r[col.name as number] ?? '';
        if (!name || isExample(name)) continue;
        const rawPrice = (col.price !== undefined ? r[col.price] : '') ?? '';
        const price = parsePrice(rawPrice);
        const label = `Item ${n + 1} "${name}"`;
        if (!rawPrice) problems.push(`${label}: the selling price is missing.`);
        else if (!(price > 0)) problems.push(`${label}: "${rawPrice}" is not a price (use a number such as 1250 or 1250.50).`);
        const key = nameKey(name);
        if (seen.has(key)) {
          problems.push(`${label}: listed twice.`);
          continue;
        }
        seen.add(key);
        if (name.length > NAME_LIMIT) problems.push(`${label}: the name is longer than ${NAME_LIMIT} characters and will be shortened.`);
        items.push({ name: stripExample(name).slice(0, NAME_LIMIT), code: (col.code !== undefined ? r[col.code] : '') ?? '', unit: ((col.unit !== undefined ? r[col.unit] : '') ?? '') || 'pcs', price, description: (col.description !== undefined ? r[col.description] : '') ?? '' });
      }
    }
  }
  if (items.length === 0 && !problems.some((p) => p.includes('Items'))) problems.push('No items were filled in on the "Items" sheet.');
  return { companies, items, problems };
}

// --- what would change ---------------------------------------------------------------------------------------------------

export interface Existing {
  contacts: Array<{ contact_name?: unknown; company_name?: unknown; email?: unknown }>;
  items: Array<{ name?: unknown; sku?: unknown }>;
}
export interface Plan {
  createCompanies: CompanyInput[];
  createItems: ItemInput[];
  skipped: string[];
}

export function planOnboarding(input: Parsed, existing: Existing): Plan {
  const names = new Set(existing.contacts.flatMap((c) => [nameKey(String(c.contact_name ?? '')), nameKey(String(c.company_name ?? ''))]));
  const emails = new Set(existing.contacts.map((c) => String(c.email ?? '').toLowerCase()).filter(Boolean));
  const skus = new Set(existing.items.map((i) => String(i.sku ?? '').toLowerCase()).filter(Boolean));
  const itemNames = new Set(existing.items.map((i) => nameKey(String(i.name ?? '').replace(/^SAMPLE - /i, ''))));
  const plan: Plan = { createCompanies: [], createItems: [], skipped: [] };
  for (const c of input.companies) {
    if (names.has(nameKey(c.name)) || (c.email && emails.has(c.email.toLowerCase()))) plan.skipped.push(`Customer "${c.name}" is already in Zoho Books.`);
    else plan.createCompanies.push(c);
  }
  for (const i of input.items) {
    if ((i.code && skus.has(i.code.toLowerCase())) || itemNames.has(nameKey(i.name))) plan.skipped.push(`Item "${i.name}" is already in Zoho Books.`);
    else plan.createItems.push(i);
  }
  return plan;
}

// --- making the changes --------------------------------------------------------------------------------------------------

export interface OnboardZoho {
  getAllPages<T = unknown>(path: string, key: string): Promise<T[]>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export const customerBody = (c: CompanyInput): Record<string, unknown> => ({
  contact_name: c.name,
  company_name: c.name,
  contact_type: 'customer',
  customer_sub_type: 'business',
  ...(c.city ? { billing_address: { city: c.city, country: 'India' } } : {}),
  ...(c.email || c.contact ? { contact_persons: [{ first_name: c.contact || c.name.slice(0, 30), ...(c.email ? { email: c.email } : {}), is_primary_contact: true }] } : {}),
});

export const itemBody = (i: ItemInput): Record<string, unknown> => ({
  name: i.name,
  ...(i.code ? { sku: i.code } : {}),
  rate: i.price,
  unit: i.unit,
  product_type: 'goods',
  item_type: 'sales',
  ...(i.description ? { description: i.description } : {}),
});

export async function applyPlan(zoho: Pick<OnboardZoho, 'post'>, plan: Plan, say: (line: string) => void = () => undefined): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;
  const run = async (what: string, path: string, body: Record<string, unknown>): Promise<void> => {
    try {
      await zoho.post(path, body);
      created++;
      say(`  created ${what}`);
    } catch (err) {
      failed++;
      const msg = errorMessage(err).slice(0, 220);
      say(`  FAILED ${what}: ${msg}${/gst|place of (supply|contact)/i.test(msg) ? ' (this Zoho organisation uses GST: add this customer by hand in Zoho Books, with its state)' : ''}`);
    }
  };
  for (const c of plan.createCompanies) await run(`customer ${c.name}`, '/contacts', customerBody(c));
  for (const i of plan.createItems) await run(`item ${i.name}`, '/items', itemBody(i));
  return { created, failed };
}

// --- the command ---------------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--template')) {
    const out = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'client-onboarding-template.xlsx');
    fs.writeFileSync(out, await buildTemplate());
    console.log(`Wrote ${out}\nSend it to the client. When they send it back, run:  npm run onboard -- their-file.xlsx`);
    return 0;
  }
  const file = args.find((a) => !a.startsWith('--'));
  if (!file || !fs.existsSync(file)) {
    console.error('Usage:\n  npm run onboard:template\n  npm run onboard -- their-file.xlsx            (preview only)\n  npm run onboard -- their-file.xlsx --create   (create in Zoho Books)');
    return 2;
  }
  const parsed = await parseOnboarding(fs.readFileSync(file));
  const blocking = parsed.problems.filter((p) => !/will be shortened/.test(p));
  for (const p of parsed.problems) console.log(`  ! ${p}`);
  if (blocking.length > 0) {
    console.error('\nPlease fix the points above in the file (or ask the client to), then run this again. Nothing was changed.');
    return 1;
  }

  const zoho = new ZohoClient(requireZoho(getConfig()));
  const plan = planOnboarding(parsed, { contacts: await zoho.getAllPages('/contacts', 'contacts'), items: await zoho.getAllPages('/items', 'items') });
  console.log(`\nZoho Books would get ${plan.createCompanies.length} customer(s) and ${plan.createItems.length} item(s):`);
  for (const c of plan.createCompanies) console.log(`  customer  ${c.name}${c.email ? `  <${c.email}>` : ''}`);
  for (const i of plan.createItems) console.log(`  item      ${i.name}${i.code ? `  [${i.code}]` : ''}  ₹${i.price} per ${i.unit}`);
  for (const s of plan.skipped) console.log(`  skipped   ${s}`);

  if (!args.includes('--create')) {
    console.log('\nThis was only a preview. Nothing was changed. To create them, run the same command with --create at the end.');
    return 0;
  }
  console.log('\nCreating...');
  const { created, failed } = await applyPlan(zoho, plan, console.log);
  console.log(`\nDone: ${created} created${failed ? `, ${failed} failed (see above)` : ''}.`);
  if (created > 0) console.log('Restart the quote assistant (Ctrl+C, then npm start) so it picks up the new items straight away. Its email must name the company as written in the Company sheet to match.');
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(errorMessage(err));
      process.exit(1);
    },
  );
}
