import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import MailComposer from 'nodemailer/lib/mail-composer';
import { loadConfig } from '../src/config';
import type { Notifier } from '../src/email/notifier';
import { setLogLevel } from '../src/logger';
import { attentionReason } from '../src/ops/monitor';
import type { ZohoContact, ZohoItem } from '../src/types';
import { createRuntime, processRawMessage, retryHeldEnquiries, runWorkflowCycle } from '../src/workflow/processor';
import { CustomerDirectory } from '../src/zoho/customerService';
import { FakeZoho } from './fakeZoho';

setLogLevel('error');

const MOCK_ZOHO = { dc: 'in', clientId: '', clientSecret: '', refreshToken: '', organizationId: 'MOCK', accountsUrl: '', apiBase: '', appBase: 'https://books.zoho.in', httpRetries: 0 };

function world(over: Record<string, string> = {}) {
  let now = new Date('2026-10-21T10:00:00Z');
  const contacts: ZohoContact[] = [];
  const items: ZohoItem[] = [{ item_id: 'i1', name: 'Relay 7A', sku: 'R-7', rate: 450, unit: 'pcs', status: 'active', product_type: 'goods' }];
  const fake = new FakeZoho(contacts, items);
  const sent: string[] = [];
  const notifier = new Proxy({}, { get: (_t, name: string) => async () => (sent.push(name), { delivered: true, dryRun: false }) }) as unknown as Notifier;
  const config = loadConfig({ AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'team@acme.test', ...over });
  const rt = createRuntime(config, { zoho: fake, zohoConfig: MOCK_ZOHO, mailbox: null, notifier, clock: () => now });
  rt.customers = new CustomerDirectory(fake, () => now.getTime());
  return {
    rt,
    contacts,
    sent,
    advance: (minutes: number): void => void (now = new Date(now.getTime() + minutes * 60_000)),
    count: (kind: string): number => sent.filter((s) => s === kind).length,
    latest: () => rt.repo.listEnquiries({ limit: 1, offset: 0 }).rows[0]!,
  };
}

const enquiry = async (from = 'buyer@newco.example', id = Math.random().toString(36).slice(2)): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RFQ');
  ws.addRow(['Item code', 'Description', 'Qty']);
  ws.addRow(['R-7', 'Relay 7A', 4]);
  ws.addRow(['R-7', 'Relay 7A spare', 2 + id.length]);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  return new Promise((resolve, reject) =>
    new MailComposer({ from, to: 'quotes@acme.test', subject: 'Quotation request', text: 'Please quote.\n\nThanks', messageId: `<${id}@test.local>`, attachments: [{ filename: 'rfq.xlsx', content: xlsx }] }).compile().build((e, m) => (e ? reject(e) : resolve(m))),
  );
};

describe('a new customer\'s first email', () => {
  it('is kept, with an alert, when the customer is not in Zoho Books yet', async () => {
    const w = world();
    const r = await processRawMessage(w.rt, await enquiry());
    assert.equal(r.results[0]?.outcome, 'halted_customer');
    assert.equal(r.handled, true, 'the mailbox copy is still marked read');
    const e = w.latest();
    assert.equal(e.status, 'HALTED_CUSTOMER_NOT_FOUND');
    assert.equal(e.holdUntil, '2026-10-28T10:00:00.000Z', 'kept for 7 days');
    assert.equal(w.rt.repo.heldCount(), 1);
    assert.equal(w.count('customerNotFound'), 1);
    assert.match(attentionReason(e), /created automatically within a few minutes.*Nobody needs to resend/s);
    w.rt.close();
  });

  it('waits quietly while the customer is still missing, and checks only now and then', async () => {
    const w = world();
    await processRawMessage(w.rt, await enquiry());
    assert.deepEqual(await retryHeldEnquiries(w.rt), { checked: 0, resolved: 0, expired: 0 }, 'too soon to check again');
    w.advance(3);
    assert.deepEqual(await retryHeldEnquiries(w.rt), { checked: 1, resolved: 0, expired: 0 });
    assert.deepEqual(await retryHeldEnquiries(w.rt), { checked: 0, resolved: 0, expired: 0 }, 'just checked');
    assert.equal(w.count('customerNotFound'), 1, 'no second alert');
    assert.equal(w.latest().status, 'HALTED_CUSTOMER_NOT_FOUND');
    w.rt.close();
  });

  it('becomes a draft quote by itself once the customer is added, matched by the sender\'s address', async () => {
    const w = world();
    await processRawMessage(w.rt, await enquiry('buyer@newco.example'));
    w.contacts.push({ contact_id: 'c1', contact_name: 'New Co Pvt Ltd', email: 'buyer@newco.example', status: 'active', contact_type: 'customer' });
    w.advance(3);
    assert.deepEqual(await retryHeldEnquiries(w.rt), { checked: 1, resolved: 1, expired: 0 });
    const e = w.latest();
    assert.equal(e.status, 'QUOTE_CREATED');
    assert.equal(e.customerName, 'New Co Pvt Ltd');
    assert.ok(e.estimateNumber);
    assert.equal(e.holdUntil, null);
    assert.equal(w.rt.repo.heldCount(), 0, 'the kept copy of the email is deleted');
    assert.equal(w.count('customerNotFound'), 1);
    assert.equal(w.count('draftCreated'), 1);
    assert.equal(w.rt.repo.listEnquiries({ limit: 10, offset: 0 }).total, 1, 'the same enquiry, not a second one');
    w.rt.close();
  });

  it('also finds the customer by their company\'s email domain', async () => {
    const w = world();
    await processRawMessage(w.rt, await enquiry('buyer@newco.example'));
    w.contacts.push({ contact_id: 'c1', contact_name: 'New Co', email: 'accounts@newco.example', status: 'active', contact_type: 'customer' });
    w.advance(3);
    assert.equal((await retryHeldEnquiries(w.rt)).resolved, 1);
    assert.equal(w.latest().matchTier, 'domain');
    w.rt.close();
  });

  it('does not make a second quote if the customer resends or the email is picked up again', async () => {
    const w = world();
    const raw = await enquiry('buyer@newco.example', 'same-message');
    await processRawMessage(w.rt, raw);
    w.contacts.push({ contact_id: 'c1', contact_name: 'New Co', email: 'buyer@newco.example', status: 'active', contact_type: 'customer' });
    w.advance(3);
    await retryHeldEnquiries(w.rt);
    assert.equal((await processRawMessage(w.rt, raw)).results[0]?.outcome, 'duplicate');
    assert.equal(w.rt.repo.listEnquiries({ limit: 10, offset: 0 }).total, 1);
    w.rt.close();
  });

  it('waits for a customer clash to be cleared, then makes the quote', async () => {
    const w = world();
    w.contacts.push({ contact_id: 'a', contact_name: 'Newco Traders', email: 'a@newco.example', status: 'active', contact_type: 'customer' }, { contact_id: 'b', contact_name: 'Newco Exports', email: 'b@newco.example', status: 'active', contact_type: 'customer' });
    await processRawMessage(w.rt, await enquiry('buyer@newco.example'));
    assert.equal(w.latest().status, 'HALTED_CUSTOMER_AMBIGUOUS');
    assert.equal(w.rt.repo.heldCount(), 1);
    w.advance(3);
    assert.equal((await retryHeldEnquiries(w.rt)).resolved, 0);
    w.contacts.splice(1, 1);
    w.advance(3);
    assert.equal((await retryHeldEnquiries(w.rt)).resolved, 1);
    assert.equal(w.latest().status, 'QUOTE_CREATED');
    w.rt.close();
  });
});

describe('how long it waits, and what it keeps', () => {
  it('lets go of the email when the days are up, and the enquiry still shows it needs a person', async () => {
    const w = world();
    await processRawMessage(w.rt, await enquiry());
    w.advance(8 * 24 * 60);
    assert.deepEqual(await retryHeldEnquiries(w.rt), { checked: 0, resolved: 0, expired: 1 });
    const e = w.latest();
    assert.equal(e.status, 'HALTED_CUSTOMER_NOT_FOUND');
    assert.equal(e.holdUntil, null);
    assert.equal(w.rt.repo.heldCount(), 0, 'the email is deleted');
    assert.ok(w.rt.repo.auditTrail(e.id).some((a) => a.event === 'HOLD_EXPIRED'));
    assert.match(attentionReason(e), /ask the sender to resend/);
    w.rt.close();
  });

  it('keeps nothing when switched off, and says the old thing', async () => {
    const w = world({ HOLD_NEW_CUSTOMER_DAYS: '0' });
    await processRawMessage(w.rt, await enquiry());
    assert.equal(w.rt.repo.heldCount(), 0);
    assert.equal(w.latest().holdUntil, null);
    assert.match(attentionReason(w.latest()), /ask the sender to resend/);
    w.rt.close();
  });

  it('stops keeping new ones at the limit, rather than filling up', async () => {
    const w = world({ HOLD_MAX_EMAILS: '1' });
    await processRawMessage(w.rt, await enquiry('a@one.example'));
    await processRawMessage(w.rt, await enquiry('b@two.example'));
    assert.equal(w.rt.repo.heldCount(), 1);
    assert.equal(w.rt.repo.listEnquiries({ limit: 10, offset: 0 }).rows.filter((e) => e.holdUntil).length, 1);
    w.rt.close();
  });

  it('a held email goes when its enquiry is deleted by the retention period', async () => {
    const w = world();
    await processRawMessage(w.rt, await enquiry());
    assert.equal(w.rt.repo.purgeOlderThan('2099-01-01T00:00:00.000Z'), 1);
    assert.equal(w.rt.repo.heldCount(), 0);
    w.rt.close();
  });
});

describe('the regular check', () => {
  it('looks at held emails at the end of every mailbox check, even when no new mail arrived', async () => {
    const w = world();
    await processRawMessage(w.rt, await enquiry('buyer@newco.example'));
    w.contacts.push({ contact_id: 'c1', contact_name: 'New Co', email: 'buyer@newco.example', status: 'active', contact_type: 'customer' });
    w.advance(3);
    w.rt.mailbox = { fetchUnseen: async () => ({ uidValidity: 1n, messages: [] }), markHandled: async () => undefined } as never;
    await runWorkflowCycle(w.rt);
    assert.equal(w.latest().status, 'QUOTE_CREATED');
    w.rt.close();
  });
});
