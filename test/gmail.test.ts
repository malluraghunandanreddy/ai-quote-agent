import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import { findUnreadUids, isAddressedTo, type EnvelopeLike, type MailboxQuery } from '../src/email/imapClient';
import { applyEnvUpdates } from '../src/ops/setupGmail';

describe('writing the settings file', () => {
  const OLD = ['# Mailbox', 'IMAP_HOST=', 'IMAP_USER=quotes@demo.example.com', 'IMAP_FOLDER=INBOX', 'ZOHO_CLIENT_ID=keep-me', 'IMAP_USER=duplicate@x.co', '# Notes', 'POLL_CRON=*/2 * * * *', ''].join('\n');

  it('replaces the existing line, removes duplicates, keeps everything else, and adds what is missing', () => {
    const out = applyEnvUpdates(OLD, { IMAP_HOST: 'imap.gmail.com', IMAP_USER: 'me@gmail.com', POLL_CRON: '* * * * *', IMAP_ONLY_TO: 'me+rfq@gmail.com' });
    const lines = out.split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('IMAP_HOST=')), ['IMAP_HOST=imap.gmail.com']);
    assert.deepEqual(lines.filter((l) => l.startsWith('IMAP_USER=')), ['IMAP_USER=me@gmail.com'], 'one line only, the duplicate is gone');
    assert.deepEqual(lines.filter((l) => l.startsWith('POLL_CRON=')), ['POLL_CRON=* * * * *']);
    assert.ok(lines.includes('ZOHO_CLIENT_ID=keep-me'), 'unrelated settings are untouched');
    assert.ok(lines.includes('# Mailbox') && lines.includes('# Notes'), 'comments are kept');
    assert.ok(lines.includes('IMAP_FOLDER=INBOX'));
    assert.ok(lines.indexOf('IMAP_ONLY_TO=me+rfq@gmail.com') > lines.indexOf('# --- Added by npm run setup:gmail ---'), 'new settings go under a heading at the end');
    assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
  });

  it('gives the same file when run twice, and works from an empty file', () => {
    const updates = { A: '1', B: 'two words' };
    const once = applyEnvUpdates(OLD, updates);
    assert.equal(applyEnvUpdates(once, updates), once);
    assert.equal(applyEnvUpdates('', { A: '1' }), '# --- Added by npm run setup:gmail ---\nA=1\n');
  });

  it('quotes a value only when the file format needs it', () => {
    const out = applyEnvUpdates('', { PLAIN: 'abc', HASH: 'a#b', SPACE_END: 'x ' });
    assert.match(out, /^PLAIN=abc$/m);
    assert.match(out, /^HASH='a#b'$/m);
    assert.match(out, /^SPACE_END='x '$/m);
  });
});

describe('only mail sent to one address', () => {
  const to = (...a: string[]): EnvelopeLike => ({ to: a.map((address) => ({ address })) });

  it('matches the exact address, in To or Cc, ignoring capitals', () => {
    const wanted = 'yourname+rfq@gmail.com';
    assert.equal(isAddressedTo(to('YourName+RFQ@Gmail.com'), wanted), true);
    assert.equal(isAddressedTo({ to: [{ address: 'a@b.co' }], cc: [{ address: wanted }] }, wanted), true);
    assert.equal(isAddressedTo(to('yourname@gmail.com'), wanted), false, 'the plain address is not the +rfq address');
    assert.equal(isAddressedTo(to('yourname+rfq2@gmail.com'), wanted), false);
    assert.equal(isAddressedTo(undefined, wanted), false);
  });

  const messages = [
    { uid: 5, envelope: to('yourname@gmail.com') },
    { uid: 3, envelope: to('YourName+RFQ@gmail.com') },
    { uid: 9, envelope: { to: [{ address: 'x@y.co' }], cc: [{ address: 'yourname+rfq@gmail.com' }] } },
    { uid: 7, envelope: to('news@shop.example') },
  ];
  const client = (): MailboxQuery & { asked?: Record<string, unknown> } => {
    const c: MailboxQuery & { asked?: Record<string, unknown> } = {
      async search(query) {
        c.asked = query;
        return messages.map((m) => m.uid);
      },
      async *fetch(range) {
        const wanted = new Set(range.split(',').map(Number));
        for (const m of messages) if (wanted.has(m.uid)) yield m;
      },
    };
    return c;
  };

  it('picks only the matching unread messages, oldest first, and counts the rest as ignored', async () => {
    const c = client();
    const now = new Date('2026-10-21T10:00:00Z');
    const r = await findUnreadUids(c, 'yourname+rfq@gmail.com', now);
    assert.deepEqual(r, { uids: [3, 9], ignored: 2 });
    assert.equal(c.asked?.seen, false);
    assert.equal((c.asked?.since as Date).toISOString(), '2026-10-07T10:00:00.000Z', 'looks back 14 days only');
  });

  it('without the setting, every unread message is picked up and no date limit is added', async () => {
    const c = client();
    assert.deepEqual(await findUnreadUids(c), { uids: [3, 5, 7, 9], ignored: 0 });
    assert.deepEqual(c.asked, { seen: false });
  });

  it('is a validated, lower-cased setting', () => {
    assert.equal(loadConfig({ IMAP_HOST: 'h', IMAP_PASSWORD: 'p', IMAP_ONLY_TO: 'Me+RFQ@Gmail.com' }).imap?.onlyTo, 'me+rfq@gmail.com');
    assert.equal(loadConfig({ IMAP_HOST: 'h', IMAP_PASSWORD: 'p' }).imap?.onlyTo, undefined);
    assert.throws(() => loadConfig({ IMAP_HOST: 'h', IMAP_PASSWORD: 'p', IMAP_ONLY_TO: 'not an address' }));
  });
});
