import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import MailComposer from 'nodemailer/lib/mail-composer';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config';
import { automaticReason, parseRawEmail } from '../src/email/mailParser';
import { setLogLevel } from '../src/logger';
import { createRuntime, processRawMessage } from '../src/workflow/processor';
import { FakeZoho } from './fakeZoho';

setLogLevel('error');

const raw = (opts: { from: string; subject: string; text?: string; headers?: Record<string, string>; attach?: boolean; id?: string }): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    new MailComposer({
      from: opts.from,
      to: 'quotes@acme.test',
      subject: opts.subject,
      text: opts.text ?? 'hello',
      messageId: opts.id ?? `<${Math.random().toString(36).slice(2)}@test.local>`,
      ...(opts.headers ? { headers: opts.headers } : {}),
      attachments: opts.attach ? [{ filename: 'rfq.xlsx', content: Buffer.from('not really a workbook') }] : [],
    })
      .compile()
      .build((e, m) => (e ? reject(e) : resolve(m))),
  );

describe('automatic mail is never an enquiry', () => {
  it('recognises the usual markers, and leaves ordinary mail alone', () => {
    const h = (o: Record<string, string>): Map<string, unknown> => new Map(Object.entries(o));
    assert.match(automaticReason(h({ 'x-quote-assistant': 'alert' }), 'a@b.co') ?? '', /own alert/);
    assert.match(automaticReason(h({ 'auto-submitted': 'auto-replied' }), 'a@b.co') ?? '', /Auto-Submitted/);
    assert.match(automaticReason(h({ precedence: 'bulk' }), 'a@b.co') ?? '', /Precedence/);
    assert.match(automaticReason(h({ 'x-autoreply': 'yes' }), 'a@b.co') ?? '', /automatic reply/);
    assert.match(automaticReason(h({}), 'MAILER-DAEMON@mail.example') ?? '', /delivery failure/);
    assert.equal(automaticReason(h({ 'auto-submitted': 'no' }), 'a@b.co'), null);
    assert.equal(automaticReason(h({ precedence: 'first-class' }), 'a@b.co'), null);
    assert.equal(automaticReason(h({}), 'buyer@customer.co'), null);
  });

  it('flags them when parsing a real message', async () => {
    const opts = { maxAttachmentBytes: 1_000_000 };
    assert.ok((await parseRawEmail(await raw({ from: 'a@b.co', subject: 's', headers: { 'Auto-Submitted': 'auto-generated' } }), opts)).automatic);
    assert.equal((await parseRawEmail(await raw({ from: 'a@b.co', subject: 's' }), opts)).automatic, null);
  });
});

describe('the assistant does not read its own alerts, even when they land in the monitored mailbox', () => {
  // The same shape as a first live setup: alerts go to the very mailbox that is being read.
  const config = (): ReturnType<typeof loadConfig> =>
    loadConfig({ AGENT_DB_PATH: ':memory:', SMTP_HOST: 'smtp.test.local', SMTP_FROM: 'quotes@acme.test', NOTIFY_INTERNAL_EMAIL: 'quotes@acme.test', EXCEPTION_STAKEHOLDERS: 'quotes@acme.test', MONITORED_INBOX: 'quotes@acme.test' });
  const MOCK_ZOHO = { dc: 'in', clientId: '', clientSecret: '', refreshToken: '', organizationId: 'MOCK', accountsUrl: '', apiBase: '', appBase: 'https://books.zoho.in', httpRetries: 0 };

  const setup = (): { rt: ReturnType<typeof createRuntime>; sent: Array<Record<string, unknown>> } => {
    const sent: Array<Record<string, unknown>> = [];
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (m: Record<string, unknown>) => void sent.push(m), verify: async () => true }));
    return { rt: createRuntime(config(), { zoho: new FakeZoho([], []), zohoConfig: MOCK_ZOHO, mailbox: null }), sent };
  };

  it('closes the loop: the alert it sends is skipped when it comes back, and nothing more is sent', async () => {
    const { rt, sent } = setup();
    try {
      // 1. a customer writes with nothing attached: the assistant sends one "more information needed" alert
      const first = await processRawMessage(rt, await raw({ from: 'buyer@customer.co', subject: 'quote please', text: 'please quote' }));
      assert.equal(first.results[0]?.outcome, 'needs_info');
      assert.equal(sent.length, 1, 'one alert');
      const alert = sent[0] as Record<string, unknown>;
      assert.deepEqual(Object.keys(alert.headers as object).sort(), ['Auto-Submitted', 'Precedence', 'X-Auto-Response-Suppress', 'X-Quote-Assistant']);

      // 2. that alert is delivered into the monitored mailbox and picked up on the next poll
      const back = await new Promise<Buffer>((resolve, reject) => new MailComposer(alert as never).compile().build((e, m) => (e ? reject(e) : resolve(m))));
      const again = await processRawMessage(rt, back);
      assert.equal(again.results[0]?.outcome, 'ignored_automatic');
      assert.equal(again.handled, true, 'it is flagged as read so it is not fetched again');
      assert.equal(sent.length, 1, 'no second alert: the loop is closed');
      assert.equal(rt.repo.listEnquiries({ limit: 10, offset: 0 }).total, 1, 'the alert did not become an enquiry');
    } finally {
      rt.close();
      mock.restoreAll();
    }
  });

  it('even if a mail server strips the markers, mail from its own address with nothing attached is skipped', async () => {
    const { rt, sent } = setup();
    try {
      const stripped = await raw({ from: '"Quote agent" <quotes@acme.test>', subject: '[Quote agent] More information needed: quote please' });
      assert.equal((await processRawMessage(rt, stripped)).results[0]?.outcome, 'ignored_automatic');
      assert.equal(sent.length, 0);
      assert.equal(rt.repo.listEnquiries({ limit: 10, offset: 0 }).total, 0);
    } finally {
      rt.close();
      mock.restoreAll();
    }
  });

  it('still handles a real enquiry sent from the same mailbox when it carries an Excel file (a self-test)', async () => {
    const { rt } = setup();
    try {
      const res = await processRawMessage(rt, await raw({ from: 'quotes@acme.test', subject: 'RFQ', attach: true }));
      assert.notEqual(res.results[0]?.outcome, 'ignored_automatic');
    } finally {
      rt.close();
      mock.restoreAll();
    }
  });

  it('does not skip ordinary customers', async () => {
    const { rt } = setup();
    try {
      for (const from of ['buyer@customer.co', 'Auto@customer.co', 'noreply@customer.co']) {
        const res = await processRawMessage(rt, await raw({ from, subject: `quote from ${from}` }));
        assert.notEqual(res.results[0]?.outcome, 'ignored_automatic', from);
      }
    } finally {
      rt.close();
      mock.restoreAll();
    }
  });
});
