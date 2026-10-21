/**
 * The emails and Excel files for the recorded end-to-end demo.   npm run demo:kit
 *
 * Writes demo-emails/<scenario>/ with an Excel file and an email.txt (subject and body to type or paste) for four
 * situations: a quote that comes out complete, one with an item that is not in the catalogue, a customer that is not
 * in Zoho Books, and an email with no attachment. The customers named in the emails are the sample customers already
 * in your Zoho Books, and the item codes are the sample items.
 *
 *   npm run demo:kit -- --check   also run all four through the real processing code against a read-only copy of your
 *                                 Zoho customers and items (nothing is created in Zoho, nothing is emailed) and say
 *                                 whether each comes out as promised.
 *
 * Every run makes new files. That matters: the same Excel sent again from the same address within 48 hours is ignored
 * as a duplicate (on purpose), so make fresh files before each take.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import MailComposer from 'nodemailer/lib/mail-composer';
import { loadConfig } from '../src/config';
import { setLogLevel } from '../src/logger';
import type { ZohoItem } from '../src/types';
import { createRuntime, processRawMessage } from '../src/workflow/processor';
import { ZohoClient } from '../src/zoho/client';
import { CustomerDirectory } from '../src/zoho/customerService';
import { FakeZoho } from './fakeZoho';

dotenv.config({ quiet: true });

const OUT = path.resolve('demo-emails');
type Cell = string | number | null;

interface Scenario {
  dir: string;
  title: string;
  subject: string;
  body: string;
  /** What to expect, for the presenter. */
  result: string;
  excel?: { file: string; rows: (ref: string) => Cell[][] };
  /** What the pipeline must do with it (used by --check). */
  expect: { outcome: string; notices: string[] };
}

const HEAD: Cell[] = ['S.NO', 'ITEM CODE', 'DESCRIPTION OF GOODS', 'QTY.', 'UNIT'];

const SCENARIOS: Scenario[] = [
  {
    dir: '1-draft-ready',
    title: 'A normal enquiry: everything is found, the draft is complete',
    subject: 'Quotation request - November requirement',
    body: `Dear Sir/Madam,

Please send us your best quotation for the items in the attached Excel. We need delivery at our godown within 3 weeks.

Thanks and regards,
Anitha R
Purchase Dept
Nellore Agro Exports
Godown 3, Port Road, Nellore`,
    expect: { outcome: 'quote_created', notices: ['C_DRAFT_CREATED'] },
    result: 'Matched to the customer "Nellore Agro Exports" by the company name in the email. Draft quote with all 3 lines priced. One alert email to your team: "Draft Quotation Created". Dashboard: Draft ready.',
    excel: {
      file: 'RFQ_Nellore_Agro_Nov.xlsx',
      rows: (ref) => [
        [`NELLORE AGRO EXPORTS - ENQUIRY NO ${ref}`],
        [`DATE: ${new Date().toLocaleDateString('en-GB').replace(/\//g, '-')}`],
        [null],
        HEAD,
        [1, '1300077549', 'Rly,Aux,Soc,P38,7A,4NO+4NC,230VAC', 10, 'NOS'],
        [2, '1200058598', 'CNTRL STN,PENDANT,LOCAL,IP55', 3, 'NOS'],
        [3, '1300037843', 'HTR,TBLR,2KW,230VAC,CR NI STL', 6, 'NOS'],
      ],
    },
  },
  {
    dir: '2-item-to-price',
    title: 'A messy ALL-CAPS enquiry with one item that is not in the catalogue',
    subject: 'URGENT QUOTATION REQUIRED!!!',
    body: `PLS QUOTE URGENT. ITEMS IN EXCEL ATTACHED.
DELIVERY BY 25TH NOV AT FISHING HARBOUR, KAKINADA.

THANKS & REGARDS
PURCHASE DEPT
KAKINADA MARINE SUPPLIES
FISHING HARBOUR RD, KAKINADA`,
    expect: { outcome: 'quote_created_with_exceptions', notices: ['B_UNMATCHED_PRODUCTS', 'C_DRAFT_CREATED'] },
    result: 'Matched to "Kakinada Marine Supplies". Draft quote created; two lines priced, the bolt line marked "manual pricing required". Two alert emails: "Draft Quotation Created" to your team and "New/Unmatched Products Identified" to the stakeholders. Dashboard: Draft, items to price.',
    excel: {
      file: 'RFQ_Kakinada_Marine.xlsx',
      rows: (ref) => [
        [`KAKINADA MARINE SUPPLIES - ENQUIRY NO ${ref}`],
        [null],
        HEAD,
        [1, '1200095170', 'XFMR CURNT AIR COOL 300/1 660 VAC CL 1', '13 NOS', 'NOS'],
        [2, '1300045213', 'MDL,RLY,THERMON', '3 NOS', 'NOS'],
        [3, '9000011111', 'HEX BOLT M12 X 60 SS304', '1,200 NOS', 'NOS'],
        [null, null, 'TOTAL', '1216 NOS', null],
      ],
    },
  },
  {
    dir: '3-unknown-customer',
    title: 'A company that is not in Zoho Books: the assistant does not guess',
    subject: 'RFQ for sprayer spare parts',
    body: `Hello,

Kindly quote for the attached list. Required in Vijayawada within 2 weeks.

Regards,
Ravi Teja
Delta Agro Tools
Autonagar, Vijayawada`,
    expect: { outcome: 'halted_customer', notices: ['CUSTOMER_NOT_FOUND'] },
    result: 'No customer found, so no draft is created. One alert email to your team: "Customer not found". Dashboard: Needs you, with what to do next.',
    excel: {
      file: 'RFQ_Delta_Agro_Tools.xlsx',
      rows: (ref) => [
        [`DELTA AGRO TOOLS - ENQUIRY NO ${ref}`],
        [null],
        HEAD,
        [1, '1300077549', 'Rly,Aux,Soc,P38,7A,4NO+4NC,230VAC', 20, 'NOS'],
        [2, '1200078573', 'LMP,DWN LGHT,18W,220-240V,30000HR,DN172B', 100, 'NOS'],
      ],
    },
  },
  {
    dir: '4-no-attachment',
    title: 'A one-line email from a phone with no attachment',
    subject: 'quote',
    body: 'bhai quote bhej do attached ka. urgent',
    expect: { outcome: 'needs_info', notices: ['A_ADDITIONAL_INFO'] },
    result: 'Nothing to read, so no draft. One alert email to your team: "Additional Information Required". Dashboard: Needs information.',
  },
];

async function workbook(rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RFQ');
  for (const r of rows) ws.addRow(r);
  ws.getColumn(3).width = 42;
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Run the four emails through the real pipeline with Zoho's customers and items copied in (read-only) and nothing sent. */
async function check(): Promise<number> {
  const config = loadConfig({ ...process.env, AGENT_DB_PATH: ':memory:', IMAP_HOST: '', SMTP_HOST: '', LOG_LEVEL: 'error' });
  setLogLevel('error');
  if (!config.zoho) {
    console.error('The check reads your real customers and items, so the ZOHO_* settings must be filled in.');
    return 1;
  }
  const live = new ZohoClient(config.zoho);
  const contacts = await new CustomerDirectory(live).customers();
  const items = await live.getAllPages<ZohoItem>('/items', 'items');
  console.log(`\nChecking against a read-only copy of ${contacts.length} customers and ${items.length} items from Zoho Books (Claude: ${config.llm.enabled ? config.llm.model : 'off'}).\n`);
  const rt = createRuntime(config, { zoho: new FakeZoho(contacts, items), zohoConfig: { ...config.zoho, organizationId: 'CHECK' }, mailbox: null });
  let failed = 0;
  try {
    for (const s of SCENARIOS) {
      const composer = new MailComposer({
        from: '"Demo Customer" <demo.customer@gmail.com>',
        to: 'rfq@demo.example',
        subject: s.subject,
        text: s.body,
        messageId: `<demo-kit-${s.dir}-${Date.now()}@check.local>`,
        attachments: s.excel ? [{ filename: s.excel.file, content: fs.readFileSync(path.join(OUT, s.dir, s.excel.file)) }] : [],
      });
      const raw: Buffer = await new Promise((resolve, reject) => composer.compile().build((e, m) => (e ? reject(e) : resolve(m))));
      const res = (await processRawMessage(rt, raw)).results[0];
      const row = rt.repo.listEnquiries({ limit: 1, offset: 0 }).rows[0];
      const notices = row ? rt.repo.notificationsFor(row.id).map((n) => n.kind).sort() : [];
      const problems: string[] = [];
      if (res?.outcome !== s.expect.outcome) problems.push(`outcome ${res?.outcome}, expected ${s.expect.outcome}`);
      if (JSON.stringify(notices) !== JSON.stringify([...s.expect.notices].sort())) problems.push(`alerts ${notices.join('+') || 'none'}, expected ${s.expect.notices.join('+')}`);
      if (s.dir.startsWith('1-') && row && (row.unmatchedCount ?? 0) !== 0) problems.push(`${row.unmatchedCount} items not found in the catalogue`);
      if (s.dir.startsWith('2-') && row && row.unmatchedCount !== 1) problems.push(`expected exactly 1 item to price, got ${row.unmatchedCount}`);
      console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${s.dir}: ${res?.outcome}${row?.customerName ? `, customer "${row.customerName}" (${row.matchTier})` : ''}${row?.lineCount ? `, ${row.matchedCount}/${row.lineCount} lines priced` : ''}, alerts: ${notices.join(' + ') || 'none'}${problems.length ? `   <-- ${problems.join('; ')}` : ''}`);
      if (problems.length) failed++;
    }
  } finally {
    rt.close();
  }
  console.log(failed === 0 ? '\nAll four behave as the notes say.' : `\n${failed} of ${SCENARIOS.length} did not behave as expected.`);
  return failed === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  const take = crypto.randomBytes(2).toString('hex').toUpperCase();
  const index: string[] = [];
  for (const s of SCENARIOS) {
    const dir = path.join(OUT, s.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (s.excel) fs.writeFileSync(path.join(dir, s.excel.file), await workbook(s.excel.rows(`${s.dir.slice(0, 1)}/2026/${take}`)));
    fs.writeFileSync(
      path.join(dir, 'email.txt'),
      `${s.title}\n${'='.repeat(s.title.length)}\n\nSEND TO:   the address the assistant reads (IMAP_ONLY_TO in .env, for example yourname+rfq@gmail.com)\nSEND FROM: the "customer" (your own Gmail is fine for a rehearsal)\nSUBJECT:   ${s.subject}\nATTACH:    ${s.excel ? s.excel.file : '(nothing: send it without an attachment)'}\n\nBODY:\n${s.body}\n\nWHAT HAPPENS:\n${s.result}\n`,
    );
    index.push(`${s.dir}: ${s.title}`);
  }
  fs.writeFileSync(
    path.join(OUT, 'README.txt'),
    `Demo emails (take ${take})\n\nSend them one at a time to the address the assistant reads (IMAP_ONLY_TO in .env).\nThen run:  npm run process-now   (or wait up to 2 minutes if the service is running).\n\n${index.join('\n')}\n\nRe-sending the same file from the same address within 48 hours is ignored as a duplicate (on purpose).\nRun  npm run demo:kit  again for fresh files before every take.\n`,
  );
  console.log(`Wrote ${SCENARIOS.length} scenarios to ${OUT} (take ${take}).`);
  if (process.argv.includes('--check')) process.exitCode = await check();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
