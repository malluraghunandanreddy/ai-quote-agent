import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../auth/passwords';
import type { Role } from '../auth/rbac';
import { loadConfig, type Config } from '../config';
import { openDatabase } from '../db';
import { Repository } from '../db/repository';
import { NoteStore, UserStore } from '../db/users';
import { startDashboard } from './server';

/**
 * Demo data for showing the dashboard to a client: about a month of believable enquiries in a throwaway database
 * (data/demo.sqlite). Everything is flagged as demo (the dashboard shows a banner) and none of it touches Zoho,
 * a mailbox, or the real database. `npm run demo` seeds and opens it; `npm run demo:seed` only seeds.
 */

const CUSTOMERS = [
  { name: 'Sri Venkateswara Electricals', email: 'purchase@svelectricals.example' },
  { name: 'Godavari Power Tech', email: 'accounts@godavaripowertech.example' },
  { name: 'Krishna Delta Steels', email: 'stores@krishnadeltasteel.example' },
  { name: 'Tirumala Cables and Conductors', email: 'orders@tirumalacables.example' },
  { name: 'Ramesh Traders', email: 'rameshtraders@mail.example' },
  { name: 'Kakinada Marine Supplies', email: 'purchase@kakinadamarine.example' },
  { name: 'Anantha Solar and Allied Services', email: 'procurement@ananthasolar.example' },
  { name: 'Rayalaseema Textile Mills', email: 'info@rayalaseematextiles.example' },
  { name: 'Sri Sai Engineering Works', email: 'sales@srisaiengineering.example' },
  { name: 'Nellore Agro Exports', email: 'orders@nelloreagro.example' },
];
const STRANGERS = [
  { company: 'Sree Rama Fabricators', email: 'sreerama.fab@mail.example' },
  { company: 'Delta Agro Tools', email: 'buyer@deltaagrotools.example' },
  { company: 'Vijaya Hardware Mart', email: 'vijayahw@mail.example' },
  { company: 'Coastal Packaging Co', email: 'purchase@coastalpack.example' },
];
const SUBJECTS = ['RFQ for spares', 'Quotation required', 'Urgent: please quote', 'Enquiry: electrical items', 'Price request attached', 'Need quote for Q4 requirement', 'Re: items list'];

/** Small seeded generator so the demo looks the same every time. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The made-up team the showcase signs in as. All share the demo password. */
export const DEMO_TEAM: Array<{ name: string; email: string; role: Role }> = [
  { name: 'Meera Reddy', email: 'meera@acme.example', role: 'owner' },
  { name: 'Karthik Rao', email: 'karthik@acme.example', role: 'manager' },
  { name: 'Anita Sharma', email: 'anita@acme.example', role: 'staff' },
  { name: 'Suresh Iyer', email: 'suresh@acme.example', role: 'viewer' },
];

export async function seedDemo(repo: Repository, users: UserStore, notes: NoteStore, setClock: (d: Date) => void, now: Date, password: string, orgId = '60092547421'): Promise<number> {
  const rand = rng(20261021);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  let seq = 0;
  let quoteNo = 100;
  let bigDone = false;
  const attention: Array<{ id: number; at: Date }> = [];
  const pricing: Array<{ id: number; at: Date }> = [];
  const listUrl = `https://books.zoho.in/app/${orgId}#/quotes`;

  const when = (daysAgo: number, hour: number, minute: number): Date => {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    // wall-clock time in India (UTC+5:30)
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, minute - 30));
  };

  const claim = (at: Date, sender: string, subject: string, hasExcel: boolean): number => {
    setClock(at);
    seq++;
    const c = repo.claim({ messageKey: `demo-${seq}`, contentHash: `demo-c-${seq}`, messageId: `<demo-${seq}@demo.example>`, senderEmail: sender, subject, attachmentName: hasExcel ? `RFQ-${1000 + seq}.xlsx` : null });
    if (c.outcome !== 'claimed') throw new Error('demo claim failed');
    return c.id;
  };
  const step = (at: Date, secs: number): Date => {
    const t = new Date(at.getTime() + secs * 1000);
    setClock(t);
    return t;
  };

  const draft = (at: Date, c: { name: string; email: string }, toPrice: boolean, big = false): void => {
    const id = claim(at, c.email, pick(SUBJECTS), true);
    let t = step(at, 4);
    repo.setEmailInfo(id, { companyInEmail: c.name, emailDate: at });
    repo.audit(id, 'EMAIL_METADATA', 'llm');
    t = step(t, 3);
    const lines = 2 + Math.floor(rand() * 8);
    repo.audit(id, 'EXCEL_PARSED', `${lines} lines, 0 unreadable, 0 ignored, columns by rules`);
    t = step(t, 1);
    repo.audit(id, 'CUSTOMER_RESOLVED', `${pick(['email', 'email', 'domain'])}:DEMO:${c.name}`);
    t = step(t, 4);
    const unmatched = toPrice ? 1 + Math.floor(rand() * Math.min(3, lines)) : 0;
    const total = big ? 1_240_000 + Math.round(rand() * 400_000) : Math.round((1500 + rand() * 52_000) / 10) * 10;
    quoteNo++;
    repo.recordEstimate(id, {
      customerId: 'DEMO', customerName: c.name, matchTier: 'email', estimateId: `DEMO-${quoteNo}`, estimateNumber: `QT-${String(quoteNo).padStart(6, '0')}`, quoteUrl: listUrl,
      totalAmount: total, currencyCode: 'INR', lineCount: lines, matchedCount: lines - unmatched, unmatchedCount: unmatched, unreadableRows: 0,
      reviewFlags: big ? ['LARGE_TOTAL'] : [],
    });
    repo.markNotification(id, 'C_DRAFT_CREATED');
    if (toPrice) repo.markNotification(id, 'B_UNMATCHED_PRODUCTS');
    repo.finish(id, toPrice ? 'QUOTE_CREATED_WITH_EXCEPTIONS' : 'QUOTE_CREATED');
    if (toPrice) pricing.push({ id, at: t });
  };

  const halted = (at: Date, who: { company: string; email: string }): number => {
    const id = claim(at, who.email, pick(SUBJECTS), true);
    step(at, 5);
    repo.setEmailInfo(id, { companyInEmail: who.company, emailDate: at });
    repo.audit(id, 'EMAIL_METADATA', 'llm');
    repo.audit(id, 'EXCEL_PARSED', `${3 + Math.floor(rand() * 5)} lines, 0 unreadable, 0 ignored, columns by rules`);
    repo.markNotification(id, 'CUSTOMER_NOT_FOUND');
    repo.finish(id, 'HALTED_CUSTOMER_NOT_FOUND', `Sender email "${who.email}": no active customer | Company name "${who.company}": no customer`);
    attention.push({ id, at });
    return id;
  };

  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const dow = (new Date(now.getTime() - daysAgo * 86_400_000).getUTCDay() + 6) % 7; // 0 = Monday
    const perDay = dow >= 5 ? (rand() < 0.4 ? 1 : 0) : 2 + Math.floor(rand() * 3) + (daysAgo === 0 ? -1 : daysAgo <= 6 ? 1 : 0); // a busier recent week reads better in a showcase
    for (let i = 0; i < Math.max(0, perDay); i++) {
      const hour = pick([9, 10, 10, 11, 11, 12, 14, 15, 15, 16, 17]);
      const at = when(daysAgo, daysAgo === 0 ? Math.min(hour, 9) : hour, Math.floor(rand() * 59));
      if (at.getTime() > now.getTime()) continue;
      const r = rand();
      const customer = pick(CUSTOMERS);
      if (r < 0.7) {
        // one unusually large quote in the last ten days, so the "check before sending" flag shows up in the showcase
        const makeBig = !bigDone && daysAgo <= 10 && daysAgo >= 2;
        if (makeBig) bigDone = true;
        draft(at, customer, false, makeBig);
      }
      else if (r < 0.86) draft(at, customer, true);
      else if (r < 0.92) {
        const who = pick(STRANGERS);
        const id = halted(at, who);
        // about half are fixed by the customer being created and the email resent
        if (rand() < 0.55 && daysAgo > 0) draft(when(daysAgo - 1, 11, 20), { name: who.company, email: who.email }, false);
        void id;
      } else if (r < 0.96) {
        const id = claim(at, pick(['raju1234@mail.example', 'newbuyer@trading.example', 'info@smallshop.example']), 'quote please', false);
        step(at, 2);
        repo.markNotification(id, 'A_ADDITIONAL_INFO');
        repo.finish(id, 'NEEDS_INFO', 'No Excel (.xlsx) attachment was found on the email.');
        attention.push({ id, at });
      } else if (daysAgo < 3) {
        const id = claim(at, pick(CUSTOMERS).email, 'Urgent: please quote', true);
        step(at, 6);
        repo.fail(id, 'Zoho Books is temporarily unavailable');
        attention.push({ id, at });
      } else draft(at, customer, false);
    }
    const day = new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const n = Math.max(1, perDay);
    repo.addLlmUsage(day, 'email_extraction', n, n * 930, n * 92);
    if (rand() < 0.15) repo.addLlmUsage(day, 'column_mapping', 1, 1280, 44);
  }

  // --- the team, what they did on enquiries, and the activity log --------------------------------------------------
  const hash = await hashPassword(password);
  const day = 86_400_000;
  const ago = (days: number, hour = 10, minute = 0): Date => when(days, hour, minute);
  const ids = new Map<string, number>();
  const add = (u: { name: string; email: string; role: Role }, daysAgo: number, createdBy?: string, mustChange = false): void => {
    setClock(ago(daysAgo, 9, 30));
    const by = createdBy ? ids.get(createdBy) : undefined;
    ids.set(u.email, users.create({ email: u.email, name: u.name, role: u.role, passwordHash: hash, mustChangePassword: mustChange, createdBy: by ?? null }).id);
  };
  const [meera, karthik, anita, suresh] = DEMO_TEAM as [(typeof DEMO_TEAM)[0], (typeof DEMO_TEAM)[0], (typeof DEMO_TEAM)[0], (typeof DEMO_TEAM)[0]];
  add(meera, 28);
  add(karthik, 27, meera.email);
  add(anita, 26, karthik.email);
  add(suresh, 20, meera.email);
  const former = { name: 'Vijay Kumar', email: 'vijay@acme.example', role: 'staff' as Role };
  add(former, 25, karthik.email);
  const newcomer = { name: 'Divya Menon', email: 'divya@acme.example', role: 'staff' as Role };
  add(newcomer, 0, karthik.email, true);
  users.setActive(ids.get(former.email) as number, false);
  const uid = (u: { email: string }): number => ids.get(u.email) as number;

  // notes and "handled" marks: everything older than the three newest open items has been dealt with
  const older = attention.slice(0, Math.max(0, attention.length - 3));
  const NOTES = ['Rang the customer. They will resend a proper Excel today.', 'Created the customer in Zoho Books and asked them to resend.', 'Duplicate of the earlier request. Nothing more to do.', 'Spoke to the buyer, quote not needed this time.', 'Zoho was down for a few minutes. Reprocessed by hand.'];
  older.forEach((a, i) => {
    const who = i % 3 === 0 ? karthik : anita;
    setClock(new Date(a.at.getTime() + (2 + (i % 5)) * 3_600_000));
    notes.add(a.id, { id: uid(who), name: who.name }, 'note', NOTES[i % NOTES.length] as string);
    setClock(new Date(a.at.getTime() + (3 + (i % 5)) * 3_600_000));
    notes.add(a.id, { id: uid(who), name: who.name }, 'handled', '');
  });
  pricing.slice(-6).forEach((d, i) => {
    const who = i % 2 === 0 ? karthik : anita;
    setClock(new Date(d.at.getTime() + 90 * 60_000));
    notes.add(d.id, { id: uid(who), name: who.name }, 'note', i % 2 === 0 ? 'Priced the open lines in Zoho and sent the quote.' : 'Waiting on the supplier price for the last item.');
  });

  type Ev = Parameters<UserStore['logEvent']>[0] & { at: Date };
  const events: Ev[] = [
    { at: ago(28, 9, 31), actorLabel: 'System', event: 'owner_created', target: meera.email, detail: 'First owner created from the settings file' },
    { at: ago(27, 9, 40), actor: { id: uid(meera), name: meera.name }, event: 'user_created', target: karthik.email, detail: 'Manager', ip: '203.0.113.21' },
    { at: ago(26, 9, 45), actor: { id: uid(karthik), name: karthik.name }, event: 'user_created', target: anita.email, detail: 'Staff', ip: '203.0.113.34' },
    { at: ago(25, 9, 50), actor: { id: uid(karthik), name: karthik.name }, event: 'user_created', target: former.email, detail: 'Staff', ip: '203.0.113.34' },
    { at: ago(20, 9, 35), actor: { id: uid(meera), name: meera.name }, event: 'user_created', target: suresh.email, detail: 'Viewer', ip: '203.0.113.21' },
    { at: ago(12, 17, 5), actor: { id: uid(karthik), name: karthik.name }, event: 'user_deactivated', target: former.email, ip: '203.0.113.34' },
    { at: ago(6, 8, 55), actorLabel: 'Someone', event: 'login_failed', target: anita.email, ip: '198.51.100.77' },
    { at: ago(4, 15, 20), actor: { id: uid(karthik), name: karthik.name }, event: 'export', detail: '43 rows, all', ip: '203.0.113.34' },
    { at: ago(0, 9, 28), actor: { id: uid(karthik), name: karthik.name }, event: 'user_created', target: newcomer.email, detail: 'Staff', ip: '203.0.113.34' },
  ];
  const who: Array<[typeof meera, string]> = [[meera, '203.0.113.21'], [karthik, '203.0.113.34'], [anita, '203.0.113.58'], [suresh, '203.0.113.90']];
  for (let d = 18; d >= 0; d--) {
    who.forEach(([u, ip], i) => {
      if ((d + i) % (i === 3 ? 4 : i === 0 ? 3 : 1) !== 0) return;
      if (d >= 20 && u === suresh) return;
      const wd = (new Date(now.getTime() - d * day).getUTCDay() + 6) % 7;
      if (wd >= 5) return;
      events.push({ at: ago(d, 9 + i, 10 + i * 7), actor: { id: uid(u), name: u.name }, event: 'login', ip });
    });
  }
  events.push({ at: ago(0, 8, 40), actor: { id: uid(anita), name: anita.name }, event: 'login', ip: '203.0.113.58' });
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const ev of events) {
    if (ev.at.getTime() > now.getTime()) continue;
    setClock(ev.at);
    const { at: _at, ...rest } = ev;
    users.logEvent(rest);
    if (ev.event === 'login' && ev.actor) users.recordSuccess(ev.actor.id);
  }

  setClock(now);
  repo.setMeta('demo', '1');
  repo.setMeta('demo_password', password);
  repo.setMeta('started_at', new Date(now.getTime() - 9 * 86_400_000).toISOString());
  repo.setMeta('last_poll_at', new Date(now.getTime() - 60_000).toISOString());
  repo.setMeta('last_poll_ok_at', new Date(now.getTime() - 60_000).toISOString());
  repo.setMeta('consecutive_failures', '0');
  repo.setMeta('last_backup_at', new Date(now.getTime() - 9 * 3_600_000).toISOString());
  repo.setMeta('last_backup_ok', '1');
  repo.setMeta('last_backup_file', 'quote-agent-demo.sqlite');
  return seq;
}

export function demoConfig(dbPath: string, port: number): Config {
  return loadConfig({
    AGENT_DB_PATH: dbPath,
    DASHBOARD_PORT: String(port),
    DASHBOARD_HOST: '127.0.0.1',
    CLIENT_NAME: 'Acme Industries',
    // So the one large sample quote is genuinely above the flag threshold shown on the Status page.
    WARN_TOTAL_ABOVE: '1000000',
    // Try a branded look: BRAND_NAME="Acme Quotes" BRAND_LOGO=branding/sample-logo.svg BRAND_COLOR="#0f7b6c" npm run demo
    BRAND_NAME: process.env.BRAND_NAME,
    BRAND_LOGO: process.env.BRAND_LOGO,
    BRAND_LOGO_ONLY: process.env.BRAND_LOGO_ONLY,
    BRAND_COLOR: process.env.BRAND_COLOR,
    BRAND_FOOTER: process.env.BRAND_FOOTER,
    SHOW_AI_COST: process.env.SHOW_AI_COST,
    // An example hourly cost so the showcase can turn hours saved into rupees; each real client sets their own figure.
    STAFF_COST_PER_HOUR: process.env.STAFF_COST_PER_HOUR ?? '300',
    // Only so the Status page shows the finished picture; nothing connects anywhere in demo mode.
    IMAP_HOST: 'imap.demo.example', IMAP_USER: 'rfq@demo.example', IMAP_PASSWORD: 'demo-not-used',
    SMTP_HOST: 'smtp.demo.example', NOTIFY_INTERNAL_EMAIL: 'sales@demo.example', EXCEPTION_STAKEHOLDERS: 'sales@demo.example,manager@demo.example',
    ZOHO_CLIENT_ID: 'demo', ZOHO_CLIENT_SECRET: 'demo', ZOHO_REFRESH_TOKEN: 'demo', ZOHO_ORGANIZATION_ID: '60092547421',
    ANTHROPIC_API_KEY: 'sk-ant-demo-not-used',
  });
}

async function main(): Promise<void> {
  const file = path.resolve('data', 'demo.sqlite');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const password = process.env.DASHBOARD_PASSWORD || 'showcase-demo-2026';
  const config = demoConfig(file, Number(process.env.DASHBOARD_PORT) || 3000);
  const db = openDatabase(file);
  let clock = new Date();
  const repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => clock });
  const users = new UserStore(db, () => clock);
  const notes = new NoteStore(db, () => clock);
  const count = await seedDemo(repo, users, notes, (d) => (clock = d), new Date(), password);
  console.log(`Seeded ${count} demo enquiries and ${users.count()} team logins into ${file}`);
  if (process.argv.includes('--seed-only')) {
    db.close();
    return;
  }
  clock = new Date();
  const live = new UserStore(db);
  const { port, close } = await startDashboard({ config, repo, users: live, notes: new NoteStore(db) });
  console.log(`\nDemo dashboard: http://localhost:${port}\nPassword for every demo login: ${password}\n${DEMO_TEAM.map((u) => `  ${u.role.padEnd(8)} ${u.email}`).join('\n')}\n(The sign-in page also has one-click buttons for each role. Ctrl+C to stop. Nothing here is real data.)`);
  const stop = async (): Promise<void> => {
    await close();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
