import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, passwordProblem } from '../auth/passwords';
import { getConfig } from '../config';
import { openDatabase } from '../db';
import { UserStore } from '../db/users';
import { ask, askHidden } from './prompt';

/**
 * One command to get the demo running on a single Gmail address.
 *
 *   npm run setup:gmail -- you@gmail.com
 *   npm run setup:gmail -- you@gmail.com --show     (typed text is visible, if pasting into the hidden prompt is confusing)
 *
 * It asks for the Gmail app password and a dashboard password (typed hidden), writes the mailbox settings into .env
 * (keeping a copy of the old file as .env.bak), creates the dashboard login, then tests the connection and sends one
 * test email. Mail is read from the normal Inbox, but only mail addressed to you+rfq@gmail.com is acted on.
 */

const quote = (v: string): string => (/[#'"`]|^\s|\s$/.test(v) ? (v.includes("'") ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : `'${v}'`) : v);

/** Set KEY=value lines in the text of an .env file: replace the first existing line, drop duplicates, add what is missing. */
export function applyEnvUpdates(text: string, updates: Record<string, string>): string {
  const out = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  const added: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${quote(value)}`;
    const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
    const at = out.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (at.length === 0) {
      added.push(line);
      continue;
    }
    out[at[0] as number] = line;
    for (const i of at.slice(1).reverse()) out.splice(i, 1);
  }
  if (added.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push('# --- Added by npm run setup:gmail ---', ...added);
  }
  return `${out.join('\n')}\n`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const show = args.includes('--show');
  const askSecret = show ? ask : askHidden;
  const address = ((args.find((a) => !a.startsWith('--')) ?? (await ask('Your Gmail address: '))) as string).trim().toLowerCase();
  const m = /^([^\s@+]+)@(gmail\.com|googlemail\.com)$/.exec(address);
  if (!m) {
    console.error('This helper is for a Gmail address such as name@gmail.com.');
    return 2;
  }
  const rfq = `${m[1]}+rfq@${m[2]}`;

  console.log(`\nSetting up ${address}. The assistant will read mail sent to ${rfq} and send its alerts to ${address}.`);
  console.log('Nothing is written until both answers are accepted. You get three tries for each.\n');

  let appPassword = '';
  for (let attempt = 1; attempt <= 3 && !appPassword; attempt++) {
    const cleaned = (await askSecret(show ? 'Paste the 16-letter Gmail app password: ' : 'Paste the 16-letter Gmail app password (you will not see it): ')).replace(/[\s-]+/g, '');
    console.log(`  Received ${cleaned.length} characters.`);
    if (/^[a-z0-9]{16}$/i.test(cleaned)) appPassword = cleaned;
    else console.log('  That is not a 16-letter code. Copy the code Google showed you (4 groups of 4 letters) and paste it again. Create a new one at https://myaccount.google.com/apppasswords if needed.');
  }
  if (!appPassword) {
    console.error('\nSETUP DID NOT FINISH: no valid app password was given. Nothing was changed. Run the command again when you have the code.');
    return 2;
  }

  let dash = '';
  for (let attempt = 1; attempt <= 3 && !dash; attempt++) {
    const first = await askSecret('Choose a password for the dashboard (at least 10 characters): ');
    const problem = passwordProblem(first, { email: address });
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    if (first !== (await askSecret('Type it again: '))) {
      console.log('  The two were not the same. Try again.');
      continue;
    }
    dash = first;
  }
  if (!dash) {
    console.error('\nSETUP DID NOT FINISH: no valid dashboard password was given. Nothing was changed. Run the command again.');
    return 2;
  }

  const file = path.resolve('.env');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (before) fs.writeFileSync(path.resolve('.env.bak'), before, { mode: 0o600 });
  fs.writeFileSync(
    file,
    applyEnvUpdates(before, {
      MONITORED_INBOX: address,
      IMAP_HOST: 'imap.gmail.com',
      IMAP_PORT: '993',
      IMAP_USER: address,
      IMAP_PASSWORD: appPassword,
      IMAP_FOLDER: 'INBOX',
      IMAP_ONLY_TO: rfq,
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '587',
      SMTP_STARTTLS: 'true',
      SMTP_USER: address,
      SMTP_PASSWORD: appPassword,
      SMTP_FROM: address,
      NOTIFY_INTERNAL_EMAIL: address,
      EXCEPTION_STAKEHOLDERS: address,
      POLL_CRON: '* * * * *',
    }),
    { mode: 0o600 },
  );

  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (before) fs.writeFileSync(file, before, { mode: 0o600 });
    console.error(`The settings were not valid, so the old .env was put back: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const db = openDatabase(config.dbPath);
  try {
    const users = new UserStore(db);
    if (users.findByEmail(address)) {
      console.log(`A dashboard login for ${address} already exists, so its password was not changed (npm run users -- reset ${address} gives a new one).`);
    } else {
      users.create({ email: address, name: 'Owner', role: 'owner', passwordHash: await hashPassword(dash), mustChangePassword: false });
      users.logEvent({ actorLabel: 'Setup command', event: 'owner_created', target: address });
      console.log(`Dashboard login created: ${address} with the password you just chose.`);
    }
  } finally {
    db.close();
  }

  console.log('\nTesting the connection and sending one test email to yourself...\n');
  // SETUP_SKIP_CHECK=1 is for automated tests only: it stops a test run from trying to log in to Gmail with a fake password.
  const check = process.env.SETUP_SKIP_CHECK === '1' ? { status: 0 } : spawnSync('npm', ['run', 'preflight', '--', '--send'], { stdio: 'inherit' });
  console.log(
    check.status === 0
      ? '\nAll set. Start the assistant with:  npm start\nThen open http://localhost:3000 and sign in with your Gmail address and the dashboard password.'
      : '\nSomething above needs fixing (look for the lines starting with a cross). Fix it, then run:  npm run preflight -- --send',
  );
  console.log('\nNotes: the assistant now checks every minute (for the demo). Your previous settings are saved in .env.bak. When the demo is finished, delete the app password in your Google account (Security, App passwords).');
  return check.status === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
