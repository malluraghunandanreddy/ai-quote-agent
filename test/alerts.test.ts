import assert from 'node:assert/strict';
import type http from 'node:http';
import { after, before, describe, it, mock } from 'node:test';
import ExcelJS from 'exceljs';
import MailComposer from 'nodemailer/lib/mail-composer';
import nodemailer from 'nodemailer';
import { ROLES, can, type Role } from '../src/auth/rbac';
import { hashPassword } from '../src/auth/passwords';
import { loadConfig } from '../src/config';
import { createDashboardServer } from '../src/dashboard/server';
import { openDatabase, type Db } from '../src/db';
import { Repository } from '../src/db/repository';
import { NoteStore, UserStore } from '../src/db/users';
import { checkRecipients, effectiveRecipients, parseAddressList, resetRecipients, saveRecipients } from '../src/ops/recipients';
import { setLogLevel } from '../src/logger';
import type { ZohoContact, ZohoItem } from '../src/types';
import { createRuntime, processRawMessage } from '../src/workflow/processor';
import { FakeZoho } from './fakeZoho';

setLogLevel('error');

const baseEnv = { AGENT_DB_PATH: ':memory:', SMTP_HOST: 'smtp.test.local', SMTP_FROM: 'quotes@acme.test', NOTIFY_INTERNAL_EMAIL: 'sales@acme.test', EXCEPTION_STAKEHOLDERS: 'stake@acme.test', MONITORED_INBOX: 'quotes@acme.test' };

describe('who receives the alerts: the rules', () => {
  const repoWith = (): Repository => new Repository(openDatabase(':memory:'), { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15 });

  it('reads a list typed one per line or separated by commas, in lower case, without repeats', () => {
    assert.deepEqual(parseAddressList(' Sales@Acme.test\nboss@acme.test, SALES@acme.test;  other@acme.test '), ['sales@acme.test', 'boss@acme.test', 'other@acme.test']);
    assert.deepEqual(parseAddressList(''), []);
  });

  it('starts from the settings file and keeps what the owner saves, until they go back', () => {
    const repo = repoWith();
    const config = loadConfig(baseEnv);
    assert.deepEqual(effectiveRecipients(repo, config), { sales: ['sales@acme.test'], stakeholders: ['stake@acme.test'], fromDashboard: false });
    saveRecipients(repo, { sales: ['a@acme.test', 'b@acme.test'], stakeholders: ['c@acme.test'] });
    assert.deepEqual(effectiveRecipients(repo, config), { sales: ['a@acme.test', 'b@acme.test'], stakeholders: ['c@acme.test'], fromDashboard: true });
    resetRecipients(repo);
    assert.equal(effectiveRecipients(repo, config).fromDashboard, false);
    repo.setMeta('alert_recipients', '{not json');
    assert.equal(effectiveRecipients(repo, config).fromDashboard, false, 'a damaged value falls back to the settings file');
  });

  it('refuses bad addresses, empty lists, too many addresses, other domains, and anyone who has written in as a customer', () => {
    const repo = repoWith();
    const claim = repo.claim({ messageKey: 'k', contentHash: 'h', messageId: 'm', senderEmail: 'Buyer@Customer.co', subject: 's', attachmentName: 'a.xlsx' });
    assert.equal(claim.outcome, 'claimed');
    const config = loadConfig({ ...baseEnv, ALERT_ALLOWED_DOMAINS: 'acme.test' });
    const check = (sales: string[], stakeholders: string[]): string[] => checkRecipients({ sales, stakeholders }, { config, isCustomerAddress: (a) => repo.isCustomerAddress(a) });

    assert.deepEqual(check(['a@acme.test'], ['b@acme.test']), []);
    assert.match(check([], ['b@acme.test']).join(' '), /Sales: add at least one/);
    assert.match(check(['a@acme.test'], []).join(' '), /Stakeholders: add at least one/);
    assert.match(check(['not-an-email'], ['b@acme.test']).join(' '), /"not-an-email" is not a valid email/);
    assert.match(check(Array.from({ length: 11 }, (_, i) => `p${i}@acme.test`), ['b@acme.test']).join(' '), /at most 10/);
    assert.match(check(['someone@gmail.com'], ['b@acme.test']).join(' '), /not on your company's email domain \(acme\.test\)/);
    // a customer who writes from the company's own domain is still refused, whatever the letter case
    const colleague = repo.claim({ messageKey: 'k3', contentHash: 'h3', messageId: 'm3', senderEmail: 'Partner@Acme.test', subject: 's', attachmentName: 'a.xlsx' });
    assert.equal(colleague.outcome, 'claimed');
    assert.match(check(['PARTNER@acme.test'], ['b@acme.test']).join(' '), /has written to you as a customer/);
    const open = loadConfig(baseEnv); // no domain rule: the customer rule still holds
    assert.match(checkRecipients({ sales: ['BUYER@customer.co'], stakeholders: ['b@acme.test'] }, { config: open, isCustomerAddress: (a) => repo.isCustomerAddress(a) }).join(' '), /written to you as a customer/);
    // the operator's own addresses are exempt, even in the one-address demo where they also write in as a "customer"
    const own = repo.claim({ messageKey: 'k2', contentHash: 'h2', messageId: 'm2', senderEmail: 'sales@acme.test', subject: 's', attachmentName: 'a.xlsx' });
    assert.equal(own.outcome, 'claimed');
    assert.deepEqual(checkRecipients({ sales: ['sales@acme.test'], stakeholders: ['sales@acme.test'] }, { config: open, isCustomerAddress: (a) => repo.isCustomerAddress(a) }), []);
  });
});

describe('the alerts go to the addresses that were chosen, and only those', () => {
  it('uses the settings file first, then the owner\'s new lists straight away, and one address for everything works too', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (m: Record<string, unknown>) => void sent.push(m), verify: async () => true }));
    const customer: ZohoContact = { contact_id: 'C1', contact_name: 'Test Customer Ltd', email: 'buyer@testcustomer.example', status: 'active', contact_type: 'customer' };
    const item = { item_id: 'I1', name: 'Relay 7A', sku: 'R-7', rate: 450, unit: 'pcs', status: 'active', product_type: 'goods' } as ZohoItem;
    const rt = createRuntime(loadConfig(baseEnv), { zoho: new FakeZoho([customer], [item]), zohoConfig: { dc: 'in', clientId: '', clientSecret: '', refreshToken: '', organizationId: 'M', accountsUrl: '', apiBase: '', appBase: 'https://books.zoho.in', httpRetries: 0 }, mailbox: null });
    const email = async (n: number): Promise<Buffer> => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('RFQ');
      ws.addRow(['Item code', 'Description', 'Qty']);
      ws.addRow(['R-7', 'Relay 7A', n]);
      ws.addRow([`ZZ-${n}`, 'Special gasket', n]);
      const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
      return new Promise((resolve, reject) => new MailComposer({ from: 'Buyer <buyer@testcustomer.example>', to: 'quotes@acme.test', subject: `RFQ ${n}`, text: 'Please quote.\n\nRegards,\nBuyer\nTest Customer Ltd', messageId: `<a${n}@t.local>`, attachments: [{ filename: 'rfq.xlsx', content: xlsx }] }).compile().build((e, m) => (e ? reject(e) : resolve(m))));
    };
    const to = (prefix: string, from: number): unknown => sent.slice(from).find((m) => String(m.subject).startsWith(prefix))?.to;
    try {
      await processRawMessage(rt, await email(2));
      assert.deepEqual(to('Draft Quotation Created', 0), ['sales@acme.test']);
      assert.deepEqual(to('New/Unmatched Products Identified', 0), ['stake@acme.test']);

      saveRecipients(rt.repo, { sales: ['new.sales@acme.test', 'second.sales@acme.test'], stakeholders: ['boss1@acme.test', 'boss2@acme.test'] });
      const mark = sent.length;
      await processRawMessage(rt, await email(3));
      assert.deepEqual(to('Draft Quotation Created', mark), ['new.sales@acme.test', 'second.sales@acme.test'], 'the very next alert goes to the new Sales list');
      assert.deepEqual(to('New/Unmatched Products Identified', mark), ['boss1@acme.test', 'boss2@acme.test']);
      assert.equal(sent.slice(mark).some((m) => JSON.stringify(m.to).includes('sales@acme.test"') && !JSON.stringify(m.to).includes('new.sales') && !JSON.stringify(m.to).includes('second.sales')), false, 'nothing still goes to the old address');

      saveRecipients(rt.repo, { sales: ['one@acme.test'], stakeholders: ['one@acme.test'] });
      const mark2 = sent.length;
      await processRawMessage(rt, await email(4));
      assert.deepEqual([to('Draft Quotation Created', mark2), to('New/Unmatched Products Identified', mark2)], [['one@acme.test'], ['one@acme.test']], 'everything pointing to one address');

      resetRecipients(rt.repo);
      const mark3 = sent.length;
      await processRawMessage(rt, await email(5));
      assert.deepEqual(to('New/Unmatched Products Identified', mark3), ['stake@acme.test'], 'reset: back to the settings file');
    } finally {
      rt.close();
      mock.restoreAll();
    }
  });
});

// --- the dashboard screen ---------------------------------------------------------------------------------------------------------

class Client {
  cookie = '';
  constructor(private readonly base: string) {}
  private async pack(res: Response): Promise<{ status: number; text: string; location: string | null }> {
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0] ?? '';
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  get(path: string): ReturnType<Client['pack']> {
    return fetch(this.base + path, { redirect: 'manual', headers: this.cookie ? { cookie: this.cookie } : {} }).then((r) => this.pack(r));
  }
  post(path: string, form: Record<string, string>): ReturnType<Client['pack']> {
    return fetch(this.base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(this.cookie ? { cookie: this.cookie } : {}) }, body: new URLSearchParams(form).toString() }).then((r) => this.pack(r));
  }
  async login(email: string): Promise<void> {
    assert.equal((await this.post('/login', { email, password: PASSWORD })).status, 303);
  }
  async csrf(): Promise<string> {
    return /name="_csrf" value="([^"]+)"/.exec((await this.get('/account')).text)?.[1] ?? '';
  }
}
const PASSWORD = 'correct horse battery';

describe('the Alerts screen', () => {
  let server: http.Server;
  let base = '';
  let db: Db;
  let repo: Repository;
  let tests: string[] = [];
  const now = new Date('2026-10-22T10:00:00Z');
  const config = loadConfig(baseEnv);

  const as = async (role: Role): Promise<Client> => {
    const c = new Client(base);
    await c.login(`${role}@x.co`);
    return c;
  };

  before(async () => {
    db = openDatabase(':memory:');
    repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    const users = new UserStore(db, () => now);
    const hash = await hashPassword(PASSWORD);
    for (const role of ROLES) users.create({ email: `${role}@x.co`, name: role.toUpperCase(), role, passwordHash: hash, mustChangePassword: false });
    server = createDashboardServer({ config, repo, users, notes: new NoteStore(db, () => now), clock: () => now, sendTestAlert: async (list) => (tests.push(list), { delivered: true, dryRun: false }) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('only an owner can open it: nobody else sees the link, and the others are refused', async () => {
    assert.deepEqual(ROLES.filter((r) => can(r, 'alerts.manage')), ['owner']);
    for (const role of ROLES) {
      const c = await as(role);
      const home = (await c.get('/')).text;
      if (role === 'owner') {
        assert.match(home, /href="\/alerts"/, 'the owner sees the Alerts link');
        assert.equal((await c.get('/alerts')).status, 200);
      } else {
        assert.doesNotMatch(home, /href="\/alerts"/, `${role} does not see the Alerts link`);
        assert.equal((await c.get('/alerts')).status, 403, `${role} typing the address is refused`);
        assert.equal((await c.post('/alerts', { _csrf: await c.csrf(), sales: 'x@acme.test', stakeholders: 'y@acme.test' })).status, 403);
        assert.equal((await c.post('/alerts/test', { _csrf: await c.csrf(), list: 'sales' })).status, 403);
        assert.equal((await c.post('/alerts/reset', { _csrf: await c.csrf() })).status, 403);
      }
    }
  });

  it('shows the current lists, saves new ones for the owner, and says it plainly', async () => {
    const owner = await as('owner');
    const page = (await owner.get('/alerts')).text;
    assert.match(page, />sales@acme\.test<\/textarea>/);
    assert.match(page, />stake@acme\.test<\/textarea>/);
    assert.match(page, /These addresses were set up when your assistant was installed/);

    const csrf = await owner.csrf();
    const r = await owner.post('/alerts', { _csrf: csrf, sales: 'New.Sales@acme.test\nsecond@acme.test', stakeholders: 'boss@acme.test' });
    assert.deepEqual([r.status, r.location], [303, '/alerts?saved=saved']);
    assert.deepEqual(effectiveRecipients(repo, config), { sales: ['new.sales@acme.test', 'second@acme.test'], stakeholders: ['boss@acme.test'], fromDashboard: true });
    const after = (await owner.get('/alerts?saved=saved')).text;
    assert.match(after, /Saved\. From now on each alert goes only to the addresses on its list/);
    assert.match(after, /These lists were set here by an owner/);
    assert.match(after, /Go back to the setup addresses/);
    assert.match((await (await as('owner')).get('/activity?filter=all')).text, /alerts_changed|alert recipients/);
    assert.match((await owner.get('/status')).text, /new\.sales@acme\.test, second@acme\.test/, 'the Status page shows the real addresses');
  });

  it('refuses a bad save, keeps what was typed, and changes nothing', async () => {
    repo.claim({ messageKey: 'kc', contentHash: 'hc', messageId: 'mc', senderEmail: 'real.customer@buyer.co', subject: 's', attachmentName: 'a.xlsx' });
    const owner = await as('owner');
    const before = effectiveRecipients(repo, config);
    const r = await owner.post('/alerts', { _csrf: await owner.csrf(), sales: 'real.customer@buyer.co\nnot-an-email', stakeholders: '' });
    assert.equal(r.status, 400);
    assert.match(r.text, /has written to you as a customer/);
    assert.match(r.text, /&quot;not-an-email&quot; is not a valid email address/);
    assert.match(r.text, /Stakeholders: add at least one/);
    assert.ok(r.text.includes('real.customer@buyer.co'), 'what was typed comes back');
    assert.deepEqual(effectiveRecipients(repo, config), before);
    assert.equal((await owner.post('/alerts', { sales: 'a@acme.test', stakeholders: 'b@acme.test' })).status, 403, 'no form token');
  });

  it('sends a test to the chosen list, and can go back to the installation settings', async () => {
    const owner = await as('owner');
    const csrf = await owner.csrf();
    const t = await owner.post('/alerts/test', { _csrf: csrf, list: 'stakeholders' });
    assert.equal(t.status, 200);
    assert.match(t.text, /A test email was sent to boss@acme\.test/);
    await owner.post('/alerts/test', { _csrf: csrf, list: 'sales' });
    assert.deepEqual(tests, ['stakeholders', 'sales']);

    const back = await owner.post('/alerts/reset', { _csrf: csrf });
    assert.deepEqual([back.status, back.location], [303, '/alerts?saved=reset']);
    assert.equal(effectiveRecipients(repo, config).fromDashboard, false);
    assert.match((await owner.get('/alerts')).text, /These addresses were set up when your assistant was installed/);
  });

  it('says so plainly when the quote service is not connected to send a test', async () => {
    const db2 = openDatabase(':memory:');
    const repo2 = new Repository(db2, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    const users2 = new UserStore(db2, () => now);
    users2.create({ email: 'owner@x.co', name: 'OWNER', role: 'owner', passwordHash: await hashPassword(PASSWORD), mustChangePassword: false });
    const lone = createDashboardServer({ config, repo: repo2, users: users2, clock: () => now });
    await new Promise<void>((r) => lone.listen(0, '127.0.0.1', r));
    try {
      const c = new Client(`http://127.0.0.1:${(lone.address() as { port: number }).port}`);
      await c.login('owner@x.co');
      assert.match((await c.get('/alerts')).text, /Sending a test needs the quote service to be running/);
      const r = await c.post('/alerts/test', { _csrf: await c.csrf(), list: 'sales' });
      assert.equal(r.status, 503);
    } finally {
      await new Promise<void>((r) => lone.close(() => r()));
      db2.close();
    }
  });
});
