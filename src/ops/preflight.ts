import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { ConfigError, getConfig, type Config } from '../config';
import { findUnreadUids, type MailboxQuery } from '../email/imapClient';
import { errorMessage } from '../logger';
import { createRuntime } from '../workflow/processor';

/**
 * "Will the live demo work?" Tries the real mailbox, the alert-email login and Zoho Books, and says in plain words what
 * is wrong. It never changes anything: unread mail stays unread, and the only email it can send is one test message to
 * your own internal address, and only with --send.
 *
 *   npm run preflight             check everything
 *   npm run preflight -- --send   also send one test email to NOTIFY_INTERNAL_EMAIL
 */

interface NetError {
  code?: string;
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  response?: string;
  responseText?: string;
  message?: string;
}

/** Turn a connection failure into something a person can act on. Exported for tests. */
export function explainConnectionError(err: unknown, what: 'IMAP' | 'SMTP', host: string): string {
  const e = (err ?? {}) as NetError;
  const text = `${e.response ?? ''} ${e.responseText ?? ''} ${e.message ?? ''}`.toLowerCase();
  const zoho = /zoho/i.test(host);
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.code === 'EDNS' || /enotfound|eai_again/.test(text)) {
    return `The server name "${host}" was not found. Check ${what}_HOST for typos and that this computer is online.${zoho ? ' For Zoho Mail India the usual names are imappro.zoho.in (reading) and smtppro.zoho.in (sending).' : ''}`;
  }
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') {
    return `Could not reach ${host}. Check ${what}_HOST and ${what}_PORT, and that no firewall or VPN is blocking the connection.${what === 'SMTP' ? ' Port 587 uses STARTTLS (SMTP_STARTTLS=true); port 465 uses SMTP_STARTTLS=false.' : ' IMAP over TLS normally uses port 993.'}`;
  }
  if (/cert|self[- ]signed|unable to verify|altname/.test(text) || /^(CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS)/.test(e.code ?? '')) {
    return `The security certificate of ${host} was not accepted. The host name is probably not the one the provider gave you.`;
  }
  if (e.authenticationFailed || e.code === 'EAUTH' || /auth|credential|login|535|password/.test(text)) {
    const gmail = /gmail|google/i.test(host);
    return `${host} refused the login. The usual causes: a wrong password; ${what === 'IMAP' ? 'IMAP access switched off in the mail account settings; ' : ''}or an app-specific password is needed because the account uses two-step sign-in.${zoho ? ' In Zoho Mail, turn on IMAP access in the mail settings, and create an app password under Zoho Accounts, Security.' : ''}${gmail ? ' Gmail does not accept the normal account password here: turn on 2-Step Verification, create an app password (Google Account, Security, App passwords), and type it without spaces.' : ''}`;
  }
  return `${errorMessage(err)}`;
}

type Line = { ok: boolean | null; text: string };
const mark = (l: Line): string => `  ${l.ok === true ? '✓' : l.ok === false ? '✗' : '•'} ${l.text}`;

async function checkImap(config: Config): Promise<{ failed: boolean; lines: Line[] }> {
  const imap = config.imap;
  if (!imap) {
    const missing = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD'].filter((k) => !process.env[k]);
    return { failed: true, lines: [{ ok: false, text: `Not set up yet. Still empty in .env: ${missing.join(', ') || 'IMAP settings'}.` }] };
  }
  const lines: Line[] = [];
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: true, auth: { user: imap.user, pass: imap.password }, tls: { minVersion: 'TLSv1.2' }, logger: false });
  client.on('error', () => undefined);
  try {
    await client.connect();
    lines.push({ ok: true, text: `Signed in to ${imap.host}:${imap.port} as ${imap.user}` });
    const folders = (await client.list()).map((f) => f.path);
    if (!folders.includes(imap.folder)) {
      lines.push({ ok: false, text: `The folder "${imap.folder}" does not exist. IMAP_FOLDER must be one of: ${folders.slice(0, 12).join(', ')}` });
      return { failed: true, lines };
    }
    const lock = await client.getMailboxLock(imap.folder);
    try {
      const { uids: unread, ignored } = await findUnreadUids(client as unknown as MailboxQuery, imap.onlyTo);
      lines.push({ ok: true, text: `Folder "${imap.folder}" found` });
      if (imap.onlyTo) lines.push({ ok: null, text: `Only mail sent to ${imap.onlyTo} is processed; ${ignored} other unread email${ignored === 1 ? '' : 's'} (last 14 days) will be left alone` });
      if (unread.length === 0) {
        lines.push({ ok: null, text: `No unread emails${imap.onlyTo ? ` sent to ${imap.onlyTo}` : ''}. Anything you send now will be the only thing the assistant processes.` });
      } else {
        lines.push({ ok: null, text: `${unread.length} unread email${unread.length === 1 ? '' : 's'} would be processed on the next check. The newest:` });
        for await (const m of client.fetch(unread.slice(-5).join(','), { envelope: true }, { uid: true })) {
          const from = m.envelope?.from?.[0];
          lines.push({ ok: null, text: `    ${from?.address ?? '?'}  "${(m.envelope?.subject ?? '').slice(0, 60)}"` });
        }
      }
    } finally {
      lock.release();
    }
    return { failed: false, lines };
  } catch (err) {
    lines.push({ ok: false, text: explainConnectionError(err, 'IMAP', imap.host) });
    return { failed: true, lines };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function checkSmtp(config: Config, send: boolean): Promise<{ failed: boolean; lines: Line[] }> {
  const smtp = config.smtp;
  if (!smtp) {
    return { failed: true, lines: [{ ok: false, text: 'Not set up yet: SMTP_HOST is empty. Without it, alert emails are only written to the log and nobody receives them.' }] };
  }
  const lines: Line[] = [];
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.verify();
    lines.push({ ok: true, text: `Signed in to ${smtp.host}:${smtp.port}${smtp.user ? ` as ${smtp.user}` : ''}` });
    lines.push({ ok: null, text: `Alerts are sent from ${config.notify.from} to ${[config.notify.internal, ...config.notify.stakeholders].filter((v, i, a) => a.indexOf(v) === i).join(', ')} (internal addresses only)` });
    if (send) {
      await transport.sendMail({
        from: config.notify.from,
        to: config.notify.internal,
        subject: 'Quote assistant: test message',
        text: 'This is a test message from the quote assistant pre-flight check. If you can read it, alert emails will reach you.',
      });
      lines.push({ ok: true, text: `Sent a test message to ${config.notify.internal}. Check that inbox (and its spam folder).` });
    } else {
      lines.push({ ok: null, text: 'No test message sent. Run with --send to send one to the internal address.' });
    }
    return { failed: false, lines };
  } catch (err) {
    lines.push({ ok: false, text: explainConnectionError(err, 'SMTP', smtp.host) });
    return { failed: true, lines };
  }
}

async function checkZoho(config: Config): Promise<{ failed: boolean; lines: Line[] }> {
  if (!config.zoho) return { failed: true, lines: [{ ok: false, text: 'Not set up yet: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID.' }] };
  const rt = createRuntime({ ...config, dbPath: ':memory:' });
  try {
    const customers = await rt.customers.customers();
    await rt.catalog.ensureLoaded();
    const lines: Line[] = [
      { ok: true, text: `Connected to Zoho Books (organization ${config.zoho.organizationId}, books.zoho.${config.zoho.dc})` },
      { ok: true, text: `${customers.length} active customers and ${rt.catalog.size} items are visible to the assistant` },
    ];
    // An empty Zoho is not an error, but it changes what the demo shows, so say so.
    if (customers.length === 0) lines.push({ ok: null, text: 'No customers yet, so every email will show "customer not found" until the sender\'s company is added in Zoho Books.' });
    if (rt.catalog.size === 0) lines.push({ ok: null, text: 'No items yet, so every line on a draft will be marked "manual pricing required" until items are added.' });
    return { failed: false, lines };
  } catch (err) {
    const why = errorMessage(err);
    const hint = /token refresh/i.test(why) ? ' The Zoho keys were refused. Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN, and that ZOHO_DC matches where the Zoho account lives (in = India).' : '';
    return { failed: true, lines: [{ ok: false, text: `Zoho Books did not answer: ${why}.${hint}` }] };
  } finally {
    rt.close();
  }
}

async function main(): Promise<number> {
  const send = process.argv.includes('--send');
  let config: Config;
  try {
    config = getConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : errorMessage(err));
    return 1;
  }
  const sections: Array<[string, Promise<{ failed: boolean; lines: Line[] }>]> = [
    ['Mailbox the customers write to (IMAP)', checkImap(config)],
    ['Alert emails to your team (SMTP)', checkSmtp(config, send)],
    ['Zoho Books', checkZoho(config)],
  ];
  let failures = 0;
  for (const [title, run] of sections) {
    const r = await run;
    console.log(`\n${title}`);
    for (const l of r.lines) console.log(mark(l));
    if (r.failed) failures++;
  }
  console.log(`\nClaude (reads the email text)\n  ${config.llm.enabled ? '✓' : '✗'} ${config.llm.enabled ? `On (${config.llm.model})` : `Off: ${config.llm.disabledReason}. Only the rules-based reading would run.`}`);
  if (!config.llm.enabled) failures++;
  console.log(failures === 0 ? '\nEverything the live demo needs is working.' : `\n${failures} thing${failures === 1 ? '' : 's'} to fix before the live demo. Edit .env, then run this again.`);
  return failures === 0 ? 0 : 1;
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
