/**
 * Creates the sample customers and items in your Zoho Books org (idempotent: anything that already exists is skipped).
 *
 *   npm run seed:zoho
 *
 * WRITES to the org in ZOHO_*. Every record is marked SAMPLE so it is easy to find and delete.
 * Place of Supply = Andhra Pradesh is set when the org is GST-enabled; otherwise Zoho rejects the field and the
 * customers are created without it (billing state is still Andhra Pradesh).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, requireZoho } from '../src/config';
import { parseRfq } from '../src/excel/parser';
import { ZohoApiError, ZohoClient } from '../src/zoho/client';
import { SAMPLE_CUSTOMERS, SAMPLE_NOTE } from './sampleData';

dotenv.config({ quiet: true });

const ITEM_COUNT = 12;

async function main(): Promise<number> {
  const cfg = requireZoho(loadConfig(process.env));
  const zoho = new ZohoClient(cfg);
  console.log(`Seeding Zoho Books ${cfg.appBase} org ${cfg.organizationId}\n`);
  let failures = 0;

  const haveEmails = new Set((await zoho.getAllPages<Record<string, unknown>>('/contacts', 'contacts')).map((c) => String(c.email ?? '').toLowerCase()));
  let gst = true;
  for (const c of SAMPLE_CUSTOMERS) {
    if (haveEmails.has(c.email.toLowerCase())) {
      console.log(`  customer exists, skipped: ${c.email}`);
      continue;
    }
    const body = (withGst: boolean) => ({
      contact_name: c.contact_name,
      company_name: c.company_name,
      contact_type: 'customer',
      customer_sub_type: 'business',
      ...(withGst ? { place_of_contact: 'AP', gst_treatment: 'business_none' } : {}),
      billing_address: { address: c.address, city: c.city, state: 'Andhra Pradesh', zip: c.zip, country: 'India' },
      notes: `${SAMPLE_NOTE} Tests: ${c.tests}`.slice(0, 500),
      contact_persons: [{ first_name: c.first, last_name: c.last, email: c.email, is_primary_contact: true }],
    });
    try {
      try {
        await zoho.post('/contacts', body(gst));
      } catch (e) {
        if (!gst || !(e instanceof ZohoApiError) || e.info.transient) throw e;
        console.log('  (this org is not GST-enabled: creating customers without Place of Supply)');
        gst = false;
        await zoho.post('/contacts', body(false));
      }
      console.log(`  customer created: ${c.email}`);
    } catch (e) {
      failures++;
      console.log(`  FAILED ${c.email}: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  const rfq = await parseRfq(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-rfq.xlsx')), { maxRows: 2000 });
  const haveSkus = new Set((await zoho.getAllPages<Record<string, unknown>>('/items', 'items')).map((i) => String(i.sku)));
  const seen = new Set<string>();
  const picks = rfq.lines.filter((l) => l.sku && !seen.has(l.sku) && seen.add(l.sku)).slice(0, ITEM_COUNT);
  for (const [i, line] of picks.entries()) {
    if (haveSkus.has(line.sku as string)) {
      console.log(`  item exists, skipped: ${line.sku}`);
      continue;
    }
    try {
      await zoho.post('/items', {
        name: `SAMPLE - ${line.description}`.slice(0, 100),
        sku: line.sku,
        rate: 150 + ((i * 97) % 2500),
        unit: 'pcs',
        product_type: 'goods',
        item_type: 'sales',
        description: SAMPLE_NOTE,
      });
      console.log(`  item created: ${line.sku}`);
    } catch (e) {
      failures++;
      console.log(`  FAILED item ${line.sku}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nDone.');
  return failures ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
