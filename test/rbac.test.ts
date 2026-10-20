import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ensureOwner } from '../src/auth/bootstrap';
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from '../src/auth/passwords';
import { ROLES, assignableRoles, can, canManage, type Role } from '../src/auth/rbac';
import { loadConfig } from '../src/config';
import { openDatabase, type Db } from '../src/db';
import { Repository } from '../src/db/repository';
import { IDLE_HOURS, MAX_FAILURES, NoteStore, SESSION_HOURS, UserError, UserStore } from '../src/db/users';
import { accentTokens, contrastWithWhite, loadBrand } from '../src/dashboard/brand';
import { overview } from '../src/dashboard/data';
import { buildDailySummary } from '../src/ops/monitor';
import { explainConnectionError } from '../src/ops/preflight';
import { createDashboardServer } from '../src/dashboard/server';
import { setLogLevel } from '../src/logger';

setLogLevel('error');

const PASSWORD = 'correct horse battery';
let hashOnce: string | undefined;
const hashed = async (): Promise<string> => (hashOnce ??= await hashPassword(PASSWORD));

// --- the rules ---------------------------------------------------------------------------------------------------------------

describe('roles and permissions', () => {
  it('each role gets exactly what it should, and every role includes the one below it', () => {
    const allowed = (r: Role): string[] => (['overview.view', 'enquiries.view', 'enquiries.annotate', 'enquiries.export', 'status.view', 'team.view', 'team.manage', 'activity.view'] as const).filter((p) => can(r, p));
    assert.deepEqual(allowed('viewer'), ['overview.view', 'enquiries.view']);
    assert.deepEqual(allowed('staff'), ['overview.view', 'enquiries.view', 'enquiries.annotate']);
    assert.deepEqual(allowed('manager'), ['overview.view', 'enquiries.view', 'enquiries.annotate', 'enquiries.export', 'status.view', 'team.view', 'team.manage']);
    assert.equal(allowed('owner').length, 8);
    for (let i = 1; i < ROLES.length; i++) for (const p of allowed(ROLES[i - 1] as Role)) assert.ok(allowed(ROLES[i] as Role).includes(p), `${ROLES[i]} lacks ${p}`);
  });

  it('owners manage everyone, managers manage only staff and viewers, nobody else manages anybody', () => {
    assert.deepEqual(assignableRoles('owner'), ['owner', 'manager', 'staff', 'viewer']);
    assert.deepEqual(assignableRoles('manager'), ['staff', 'viewer']);
    assert.deepEqual(assignableRoles('staff'), []);
    assert.deepEqual(assignableRoles('viewer'), []);
    assert.equal(canManage('manager', 'manager'), false);
    assert.equal(canManage('manager', 'owner'), false);
    assert.equal(canManage('staff', 'viewer'), false);
    assert.equal(canManage('owner', 'owner'), true);
  });
});

describe('passwords', () => {
  it('hashes with a fresh salt, verifies, and rejects wrong or malformed input', async () => {
    const a = await hashPassword('a long enough password');
    const b = await hashPassword('a long enough password');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('scrypt$'));
    assert.equal(await verifyPassword('a long enough password', a), true);
    assert.equal(await verifyPassword('a long enough passwore', a), false);
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
    assert.equal(await verifyPassword('x', 'scrypt$1$2$3$bad'), false);
  });

  it('enforces a sensible policy in plain words', () => {
    assert.match(passwordProblem('short') ?? '', /at least 10/);
    assert.match(passwordProblem('aaaaaaaaaaaa') ?? '', /repeats/);
    assert.match(passwordProblem('Password123') ?? '', /common/);
    assert.match(passwordProblem('meera@acme.example', { email: 'meera@acme.example' }) ?? '', /email/);
    assert.equal(passwordProblem('three plain words here', { email: 'a@b.co', name: 'Meera' }), null);
  });

  it('generates one-time passwords that pass the policy and avoid look-alike characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      assert.match(p, /^[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}$/);
      assert.doesNotMatch(p, /[01OIl]/);
      assert.equal(passwordProblem(p), null);
      seen.add(p);
    }
    assert.equal(seen.size, 50);
  });
});

// --- people and sessions ------------------------------------------------------------------------------------------------------

describe('user store', () => {
  let now = new Date('2026-10-21T10:00:00Z');
  const make = (): { db: Db; users: UserStore } => {
    const db = openDatabase(':memory:');
    return { db, users: new UserStore(db, () => now) };
  };

  it('refuses a second login with the same email, whatever the capitalisation', async () => {
    const { users } = make();
    users.create({ email: 'A@x.co', name: 'A', role: 'staff', passwordHash: await hashed(), mustChangePassword: false });
    assert.throws(() => users.create({ email: 'a@X.CO', name: 'B', role: 'staff', passwordHash: 'h', mustChangePassword: false }), (e: unknown) => e instanceof UserError && e.code === 'duplicate_email');
    assert.equal(users.findByEmail('a@x.co')?.name, 'A');
  });

  it('never leaves the account without an active owner', async () => {
    const { users } = make();
    const h = await hashed();
    const a = users.create({ email: 'a@x.co', name: 'A', role: 'owner', passwordHash: h, mustChangePassword: false });
    assert.throws(() => users.setRole(a.id, 'manager'), (e: unknown) => e instanceof UserError && e.code === 'last_owner');
    assert.throws(() => users.setActive(a.id, false), (e: unknown) => e instanceof UserError && e.code === 'last_owner');
    const b = users.create({ email: 'b@x.co', name: 'B', role: 'owner', passwordHash: h, mustChangePassword: false });
    users.setRole(a.id, 'manager');
    assert.throws(() => users.setActive(b.id, false), (e: unknown) => e instanceof UserError && e.code === 'last_owner');
    assert.equal(users.activeOwners(), 1);
  });

  it('gives an unknown role in the file the least access, never the most', () => {
    const { db, users } = make();
    db.prepare("INSERT INTO users (email, display_name, role, password_hash, created_at, updated_at) VALUES ('z@x.co','Z','god','h','t','t')").run();
    assert.equal(users.findByEmail('z@x.co')?.role, 'viewer');
  });

  it('pauses a login after repeated wrong passwords, then lets it recover', async () => {
    const { users } = make();
    const u = users.create({ email: 'a@x.co', name: 'A', role: 'staff', passwordHash: await hashed(), mustChangePassword: false });
    for (let i = 1; i < MAX_FAILURES; i++) assert.equal(users.recordFailure(u.id).locked, false);
    assert.equal(users.recordFailure(u.id).locked, true);
    assert.equal(users.isLocked(users.get(u.id) as never), true);
    now = new Date(now.getTime() + 16 * 60_000);
    assert.equal(users.isLocked(users.get(u.id) as never), false);
    now = new Date('2026-10-21T10:00:00Z');
  });

  it('keeps only a fingerprint of the cookie, expires sessions, and drops them when a person is switched off', async () => {
    const { db, users } = make();
    const h = await hashed();
    const u = users.create({ email: 'a@x.co', name: 'A', role: 'staff', passwordHash: h, mustChangePassword: false });
    const owner = users.create({ email: 'o@x.co', name: 'O', role: 'owner', passwordHash: h, mustChangePassword: false });
    const s = users.createSession(u.id, { ip: '1.2.3.4', userAgent: 'x' });
    const stored = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0]?.id, s.token);
    assert.equal(users.sessionFor(s.token)?.user.id, u.id);
    assert.equal(users.sessionFor('nonsense'), undefined);

    now = new Date(now.getTime() + (IDLE_HOURS + 1) * 3_600_000);
    assert.equal(users.sessionFor(s.token), undefined, 'idle too long');
    now = new Date('2026-10-21T10:00:00Z');

    const s2 = users.createSession(u.id);
    now = new Date(now.getTime() + 3_500_000 * 3);
    assert.ok(users.sessionFor(s2.token), 'still fine, kept active');
    now = new Date(new Date('2026-10-21T10:00:00Z').getTime() + (SESSION_HOURS + 1) * 3_600_000);
    assert.equal(users.sessionFor(s2.token), undefined, 'past the absolute limit');
    now = new Date('2026-10-21T10:00:00Z');

    const s3 = users.createSession(u.id);
    void owner;
    users.setActive(u.id, false);
    assert.equal(users.sessionFor(s3.token), undefined);
  });

  it('handled marks follow the latest of handled / reopened', async () => {
    const { db } = make();
    const repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    const c = repo.claim({ messageKey: 'k', contentHash: 'c', messageId: 'm', senderEmail: 's@x.co', subject: 's', attachmentName: null });
    assert.equal(c.outcome, 'claimed');
    const id = c.outcome === 'claimed' ? c.id : 0;
    const notes = new NoteStore(db, () => now);
    const who = { id: 1, name: 'A' };
    notes.add(id, who, 'note', 'hello');
    assert.equal(notes.isHandled(id), false);
    notes.add(id, who, 'handled', '');
    assert.equal(notes.isHandled(id), true);
    assert.ok(notes.handledIds().has(id));
    notes.add(id, who, 'reopened', '');
    assert.equal(notes.isHandled(id), false);
    assert.equal(notes.handledIds().size, 0);
    notes.add(id, who, 'note', 'x'.repeat(900));
    assert.equal(notes.forEnquiry(id).at(-1)?.body.length, 500);
  });
});

describe('first owner', () => {
  it('is created once from the settings file and must choose a new password', async () => {
    const db = openDatabase(':memory:');
    const users = new UserStore(db);
    const none = await ensureOwner(users, loadConfig({ NOTIFY_INTERNAL_EMAIL: 'sales@x.co' }));
    assert.equal(none.created, false);
    const config = loadConfig({ DASHBOARD_PASSWORD: 'a long starting password', DASHBOARD_OWNER_EMAIL: 'Boss@X.co', NOTIFY_INTERNAL_EMAIL: 'sales@x.co' });
    const r = await ensureOwner(users, config);
    assert.deepEqual([r.created, r.email], [true, 'boss@x.co']);
    const u = users.findByEmail('boss@x.co');
    assert.equal(u?.role, 'owner');
    assert.equal(u?.mustChangePassword, true);
    assert.equal((await ensureOwner(users, config)).created, false);
    // once anyone has a login, the settings-file password does nothing
    const other = new UserStore(openDatabase(':memory:'));
    const fallback = await ensureOwner(other, loadConfig({ DASHBOARD_PASSWORD: 'a long starting password', NOTIFY_INTERNAL_EMAIL: 'sales@x.co' }));
    assert.equal(fallback.email, 'sales@x.co');
  });
});

// --- the dashboard over HTTP -----------------------------------------------------------------------------------------------

class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async get(path: string): Promise<{ status: number; text: string; location: string | null; headers: Headers }> {
    const res = await fetch(this.base + path, { redirect: 'manual', headers: this.cookie ? { cookie: this.cookie } : {} });
    return this.pack(res);
  }

  async post(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; text: string; location: string | null; headers: Headers }> {
    const res = await fetch(this.base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: new URLSearchParams(form).toString() });
    return this.pack(res);
  }

  private async pack(res: Response): Promise<{ status: number; text: string; location: string | null; headers: Headers }> {
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.startsWith('qa_session=;') || /Max-Age=0/.test(set) ? '' : set.split(';')[0] ?? '';
    return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
  }

  /** The CSRF value this person's pages carry. */
  async csrf(): Promise<string> {
    const html = (await this.get('/account')).text;
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    assert.ok(m, 'no csrf field on /account');
    return m[1] as string;
  }

  async login(email: string, password = PASSWORD): Promise<number> {
    return (await this.post('/login', { email, password })).status;
  }
}

describe('dashboard sign-in, roles and actions', () => {
  let server: http.Server;
  let base = '';
  let db: Db;
  let users: UserStore;
  let notes: NoteStore;
  let repo: Repository;
  let ids: Record<string, number> = {};
  let enquiryId = 0;
  let attentionId = 0;
  const now = new Date('2026-10-21T10:00:00Z');
  const config = loadConfig({ AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'sales@example.com', CLIENT_NAME: 'Acme <b>' });

  const as = async (email: string): Promise<Client> => {
    const c = new Client(base);
    assert.equal(await c.login(email), 303, `${email} could not sign in`);
    return c;
  };

  before(async () => {
    db = openDatabase(':memory:');
    repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    users = new UserStore(db, () => now);
    notes = new NoteStore(db, () => now);
    const h = await hashed();
    const mk = (email: string, name: string, role: Role, must = false): number => users.create({ email, name, role, passwordHash: h, mustChangePassword: must }).id;
    ids = {
      owner: mk('owner@x.co', 'Olive Owner', 'owner'),
      manager: mk('manager@x.co', 'Manu Manager', 'manager'),
      manager2: mk('manager2@x.co', 'Mina Manager', 'manager'),
      staff: mk('staff@x.co', 'Sita Staff', 'staff'),
      viewer: mk('viewer@x.co', 'Vik Viewer', 'viewer'),
      evil: mk('evil@x.co', '<script>alert(1)</script>', 'staff'),
    };
    const claim = (key: string, subject: string): number => {
      const c = repo.claim({ messageKey: key, contentHash: key, messageId: key, senderEmail: `${key}@cust.co`, subject, attachmentName: 'a.xlsx' });
      if (c.outcome !== 'claimed') throw new Error('claim failed');
      return c.id;
    };
    enquiryId = claim('one', '=HYPERLINK("http://evil.example","click")');
    repo.recordEstimate(enquiryId, { customerId: 'c', estimateId: 'e', estimateNumber: 'QT-000001', quoteUrl: 'https://books.zoho.in/x', totalAmount: 1000, currencyCode: 'INR', lineCount: 2, matchedCount: 2, unmatchedCount: 0, customerName: 'Acme Ltd' });
    repo.finish(enquiryId, 'QUOTE_CREATED');
    attentionId = claim('two', 'Quote please');
    repo.finish(attentionId, 'NEEDS_INFO', 'No Excel found');
    server = createDashboardServer({ config, repo, users, notes, clock: () => now });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('serves the health check and assets without a login, and sends everything else to the sign-in page', async () => {
    const c = new Client(base);
    assert.equal((await c.get('/healthz')).headers.get('content-type')?.startsWith('application/json'), true);
    assert.equal((await c.get('/assets/app.css')).status, 200);
    for (const p of ['/', '/enquiries', '/team', '/enquiry/1', '/account', '/enquiries.csv']) {
      const r = await c.get(p);
      assert.deepEqual([p, r.status, r.location], [p, 303, '/login']);
    }
    const login = await c.get('/login');
    assert.equal(login.status, 200);
    assert.match(login.text, /name="email"/);
    assert.doesNotMatch(login.text, /demo-pick/);
  });

  it('says the same thing whether the email is unknown or the password is wrong, and signs in with the right one', async () => {
    const a = await new Client(base).post('/login', { email: 'nobody@x.co', password: 'whatever password' });
    const b = await new Client(base).post('/login', { email: 'staff@x.co', password: 'whatever password' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    const msg = (t: string): string => /class="badmsg"[^>]*>([^<]+)</.exec(t)?.[1] ?? '';
    assert.ok(msg(a.text).length > 10);
    assert.equal(msg(a.text), msg(b.text));

    const c = new Client(base);
    const ok = await c.post('/login', { email: 'STAFF@x.co ', password: PASSWORD });
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/');
    const set = ok.headers.get('set-cookie') ?? '';
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    const token = decodeURIComponent(/qa_session=([^;]+)/.exec(set)?.[1] ?? '');
    const rows = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    assert.ok(rows.length > 0 && rows.every((r) => r.id !== token), 'the cookie value must not be stored as-is');
    assert.equal((await c.get('/')).status, 200);
  });

  it('pauses a login after five wrong passwords, even for the right password, and logs it', async () => {
    const c = new Client(base);
    for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await c.post('/login', { email: 'evil@x.co', password: 'wrong wrong wrong' })).status, 401);
    assert.equal(await c.login('evil@x.co'), 401, 'correct password is refused while paused');
    assert.ok(users.events({ kinds: ['login_locked'], limit: 5, offset: 0 }).total >= 1);
    users.unlock(ids.evil as number);
    assert.equal(await c.login('evil@x.co'), 303);
  });

  const PAGES = ['/', '/enquiries', '/enquiries.csv', '/enquiry/1', '/status', '/team', '/activity', '/data', '/account'];
  const EXPECT: Record<string, number[]> = {
    // order follows PAGES
    viewer: [200, 200, 403, 200, 403, 403, 403, 200, 200],
    staff: [200, 200, 403, 200, 403, 403, 403, 200, 200],
    manager: [200, 200, 200, 200, 200, 200, 403, 200, 200],
    owner: [200, 200, 200, 200, 200, 200, 200, 200, 200],
  };
  for (const role of ['viewer', 'staff', 'manager', 'owner'] as const) {
    it(`${role}: sees exactly the pages the role allows, and only links to those`, async () => {
      const c = await as(`${role}@x.co`);
      for (const [i, p] of PAGES.entries()) assert.equal((await c.get(p)).status, EXPECT[role]?.[i], `${role} ${p}`);
      const html = (await c.get('/')).text;
      for (const [href, perm] of [['/team', 'team.view'], ['/status', 'status.view'], ['/activity', 'activity.view']] as const) {
        assert.equal(html.includes(`href="${href}"`), can(role, perm), `${role} nav ${href}`);
      }
      assert.match(html, new RegExp(`class="role ${role}"`));
    });
  }

  it('turned-away requests are recorded and explain themselves', async () => {
    const c = await as('viewer@x.co');
    const r = await c.get('/team');
    assert.equal(r.status, 403);
    assert.match(r.text, /Not available for your role/);
    const ev = users.events({ kinds: ['access_denied'], limit: 5, offset: 0 }).rows[0];
    assert.equal(ev?.actor, 'Vik Viewer');
    assert.equal(ev?.target, '/team');
  });

  it('lets staff add notes and mark handled, and refuses viewers, bad forms and other sites', async () => {
    const staff = await as('staff@x.co');
    const token = await staff.csrf();
    const noted = await staff.post(`/enquiry/${attentionId}/note`, { _csrf: token, body: '  Called them <b>today</b>  ' });
    assert.deepEqual([noted.status, noted.location], [303, `/enquiry/${attentionId}?saved=note`]);
    const page = (await staff.get(`/enquiry/${attentionId}`)).text;
    assert.match(page, /Called them &lt;b&gt;today&lt;\/b&gt;/);
    assert.doesNotMatch(page, /<b>today<\/b>/);
    assert.match(page, /Sita Staff/);

    assert.equal((await staff.post(`/enquiry/${attentionId}/handled`, { _csrf: token, body: '' })).status, 303);
    assert.equal(notes.isHandled(attentionId), true);
    assert.equal((await staff.post(`/enquiry/${attentionId}/reopen`, { _csrf: token })).status, 303);
    assert.equal(notes.isHandled(attentionId), false);

    assert.equal((await staff.post(`/enquiry/${attentionId}/note`, { body: 'no token' })).status, 403, 'missing csrf');
    assert.equal((await staff.post(`/enquiry/${attentionId}/note`, { _csrf: 'forged', body: 'x' })).status, 403, 'wrong csrf');
    assert.equal((await staff.post(`/enquiry/${attentionId}/note`, { _csrf: token, body: 'x' }, { origin: 'http://evil.example' })).status, 403, 'other site');
    assert.equal((await staff.post(`/enquiry/${attentionId}/note`, { _csrf: token, body: '   ' })).location, `/enquiry/${attentionId}?saved=empty`);

    const viewer = await as('viewer@x.co');
    const vt = await viewer.csrf();
    const before = notes.forEnquiry(attentionId).length;
    assert.equal((await viewer.post(`/enquiry/${attentionId}/note`, { _csrf: vt, body: 'sneaky' })).status, 403);
    assert.equal(notes.forEnquiry(attentionId).length, before);
    assert.doesNotMatch((await viewer.get(`/enquiry/${attentionId}`)).text, /Save note/);
  });

  it('takes handled items off the "needs you" list', async () => {
    const owner = await as('owner@x.co');
    const t = await owner.csrf();
    const desk = (html: string): string => /id="h-desk"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    await owner.post(`/enquiry/${attentionId}/reopen`, { _csrf: t });
    assert.match(desk((await owner.get('/')).text), /href="\/enquiry\/2"/);
    await owner.post(`/enquiry/${attentionId}/handled`, { _csrf: t, body: 'done' });
    const after = desk((await owner.get('/')).text);
    assert.doesNotMatch(after, /href="\/enquiry\/2"/);
    assert.match(after, /marked handled by your team/);
    await owner.post(`/enquiry/${attentionId}/reopen`, { _csrf: t });
  });

  it('exports a CSV that cannot run as a spreadsheet formula, and logs who took it', async () => {
    const manager = await as('manager@x.co');
    const r = await manager.get('/enquiries.csv?filter=all');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="enquiries-all-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(r.text, /'=HYPERLINK/);
    assert.doesNotMatch(r.text, /(^|,)=HYPERLINK/m);
    const ev = users.events({ kinds: ['export'], limit: 1, offset: 0 }).rows[0];
    assert.equal(ev?.actor, 'Manu Manager');
  });

  it('keeps the hierarchy: managers add staff and viewers only, and cannot touch peers or owners', async () => {
    const manager = await as('manager@x.co');
    const t = await manager.csrf();
    const made = await manager.post('/team/new', { _csrf: t, name: 'Nina New', email: 'nina@x.co', role: 'staff' });
    assert.equal(made.status, 200);
    const temp = /<code>([^<]+)<\/code>/.exec(made.text)?.[1] ?? '';
    assert.match(temp, /^[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}$/);
    assert.equal(users.findByEmail('nina@x.co')?.mustChangePassword, true);

    assert.equal((await manager.post('/team/new', { _csrf: t, name: 'X', email: 'x1@x.co', role: 'manager' })).status, 403);
    assert.equal((await manager.post('/team/new', { _csrf: t, name: 'X', email: 'x2@x.co', role: 'owner' })).status, 403);
    assert.equal(users.findByEmail('x1@x.co'), undefined);
    assert.equal((await manager.post('/team/new', { _csrf: t, name: 'Dup', email: 'NINA@x.co', role: 'viewer' })).status, 409);
    assert.equal((await manager.post('/team/new', { _csrf: t, name: 'Bad', email: 'not-an-email', role: 'viewer' })).status, 400);

    assert.equal((await manager.get(`/team/${ids.owner}`)).status, 403);
    assert.equal((await manager.get(`/team/${ids.manager2}`)).status, 403);
    assert.equal((await manager.post(`/team/${ids.manager2}/active`, { _csrf: t, active: '0' })).status, 403);
    assert.equal(users.get(ids.manager2 as number)?.active, true);
    assert.equal((await manager.post(`/team/${ids.staff}/role`, { _csrf: t, role: 'owner' })).status, 403);
    assert.equal(users.get(ids.staff as number)?.role, 'staff');
    assert.equal((await manager.get(`/team/${ids.manager}`)).location, '/account', 'own page is the account page');

    const staff = await as('staff@x.co');
    const st = await staff.csrf();
    assert.equal((await staff.post('/team/new', { _csrf: st, name: 'Y', email: 'y@x.co', role: 'viewer' })).status, 403);
    assert.equal((await staff.post(`/team/${ids.viewer}/active`, { _csrf: st, active: '0' })).status, 403);
  });

  it('lets an owner add a manager; the new person must choose a password before anything else', async () => {
    const owner = await as('owner@x.co');
    const t = await owner.csrf();
    const made = await owner.post('/team/new', { _csrf: t, name: 'Maya Manager', email: 'maya@x.co', role: 'manager' });
    assert.equal(made.status, 200);
    const temp = /<code>([^<]+)<\/code>/.exec(made.text)?.[1] ?? '';

    const maya = new Client(base);
    assert.equal((await maya.post('/login', { email: 'maya@x.co', password: temp })).status, 303);
    for (const p of ['/', '/enquiries', '/team']) assert.deepEqual([p, (await maya.get(p)).location], [p, '/account/password']);
    const gate = await maya.get('/account/password');
    assert.equal(gate.status, 200);
    assert.match(gate.text, /Choose your own password/);
    assert.doesNotMatch(gate.text, /href="\/team"/, 'no menu until the password is chosen');
    const token = /name="_csrf" value="([^"]+)"/.exec(gate.text)?.[1] ?? '';

    const weak = await maya.post('/account/password', { _csrf: token, current: temp, password: 'short', confirm: 'short' });
    assert.equal(weak.status, 400);
    assert.match(weak.text, /at least 10/);
    assert.equal((await maya.post('/account/password', { _csrf: token, current: temp, password: 'another long password', confirm: 'different long password' })).status, 400);
    assert.equal((await maya.post('/account/password', { _csrf: token, current: 'not the one', password: 'another long password', confirm: 'another long password' })).status, 400);
    const good = await maya.post('/account/password', { _csrf: token, current: temp, password: 'another long password', confirm: 'another long password' });
    assert.deepEqual([good.status, good.location], [303, '/']);
    assert.equal((await maya.get('/')).status, 200);
    assert.equal((await maya.get('/team')).status, 200);
    assert.equal(users.findByEmail('maya@x.co')?.mustChangePassword, false);
    assert.equal(await new Client(base).login('maya@x.co', temp), 401, 'the one-time password stops working');
  });

  it('changes a role at once, signs a person out when they are switched off, and when their password is reset', async () => {
    const owner = await as('owner@x.co');
    const t = await owner.csrf();
    const staff = await as('viewer@x.co');
    assert.equal((await staff.get('/enquiries.csv')).status, 403);
    await owner.post(`/team/${ids.viewer}/role`, { _csrf: t, role: 'manager' });
    assert.equal((await staff.get('/enquiries.csv')).status, 200, 'new role applies on the next page');
    await owner.post(`/team/${ids.viewer}/role`, { _csrf: t, role: 'viewer' });

    await owner.post(`/team/${ids.viewer}/active`, { _csrf: t, active: '0' });
    const gone = await staff.get('/');
    assert.deepEqual([gone.status, gone.location], [303, '/login']);
    assert.equal(await new Client(base).login('viewer@x.co'), 401);
    await owner.post(`/team/${ids.viewer}/active`, { _csrf: t, active: '1' });
    assert.equal(await new Client(base).login('viewer@x.co'), 303);

    const again = await as('viewer@x.co');
    const reset = await owner.post(`/team/${ids.viewer}/reset`, { _csrf: t });
    assert.equal(reset.status, 200);
    assert.equal((await again.get('/')).location, '/login');
    assert.equal(await new Client(base).login('viewer@x.co'), 401, 'old password is gone');
    await users.setPassword(ids.viewer as number, await hashed(), false);
  });

  it('protects the last owner even from the Team page', async () => {
    const owner = await as('owner@x.co');
    const t = await owner.csrf();
    const second = await owner.post('/team/new', { _csrf: t, name: 'Oscar Owner', email: 'oscar@x.co', role: 'owner' });
    assert.equal(second.status, 200);
    const oscar = users.findByEmail('oscar@x.co');
    assert.ok(oscar);
    // olive demotes oscar: fine, she stays the only owner
    assert.equal((await owner.post(`/team/${oscar?.id}/role`, { _csrf: t, role: 'manager' })).status, 200);
    assert.equal(users.activeOwners(), 1);
    // a manager still cannot reach her
    const mgr = await as('manager@x.co');
    assert.equal((await mgr.post(`/team/${ids.owner}/active`, { _csrf: await mgr.csrf(), active: '0' })).status, 403);
    assert.equal(users.get(ids.owner as number)?.active, true);
  });

  it('changing your password signs out your other devices but not this one', async () => {
    const one = await as('staff@x.co');
    const two = await as('staff@x.co');
    const t = await one.csrf();
    const r = await one.post('/account/password', { _csrf: t, current: PASSWORD, password: 'a brand new passphrase', confirm: 'a brand new passphrase' });
    assert.equal(r.status, 303);
    assert.equal((await one.get('/')).status, 200);
    assert.equal((await two.get('/')).location, '/login');
    await users.setPassword(ids.staff as number, await hashed(), false);
  });

  it('can sign out other devices on request, and logging out ends the session', async () => {
    const a = await as('staff@x.co');
    const b = await as('staff@x.co');
    assert.match((await a.get('/account')).text, /Sign out my other devices/);
    await a.post('/account/signout-others', { _csrf: await a.csrf() });
    assert.equal((await a.get('/')).status, 200);
    assert.equal((await b.get('/')).location, '/login');
    const old = a.cookie;
    assert.equal((await a.post('/logout', {})).location, '/login');
    const stale = new Client(base);
    stale.cookie = old;
    assert.equal((await stale.get('/')).location, '/login', 'the old cookie is dead');
  });

  it('writes a readable activity log that only owners can open', async () => {
    const owner = await as('owner@x.co');
    assert.match((await owner.get('/activity')).text, /signed in/);
    assert.match((await owner.get('/activity?filter=team')).text, /Manu Manager added nina@x\.co as Staff/);
    assert.match((await owner.get('/activity?filter=work')).text, /Sita Staff added a note on Enquiry #2/);
    assert.match((await owner.get('/activity?filter=downloads')).text, /Manu Manager downloaded the enquiry list/);
    const signins = (await owner.get('/activity?filter=signins')).text;
    assert.doesNotMatch(signins, /added a note/);
    assert.match(signins, /wrong password was entered/);
    assert.equal((await (await as('manager@x.co')).get('/activity')).status, 403);
  });

  it('escapes names and company text everywhere, and no page needs inline styles', async () => {
    const owner = await as('owner@x.co');
    const hostile = users.findByEmail('evil@x.co');
    assert.ok(hostile);
    const seen: string[] = [];
    for (const p of ['/', '/enquiries', '/enquiry/1', '/enquiry/2', '/status', '/team', `/team/${hostile?.id}`, '/activity', '/data', '/account', '/login']) {
      const c = p === '/login' ? new Client(base) : owner;
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(r.text, /<script>alert\(1\)<\/script>/, `${p} leaks the name unescaped`);
      assert.doesNotMatch(r.text, /<b>[^<]*<\/b>(?=[^<]*<\/title>)/);
      assert.doesNotMatch(r.text, /\sstyle="/, `${p} has an inline style, which the security policy blocks`);
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      seen.push(p);
    }
    assert.ok((await owner.get('/team')).text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok((await owner.get('/')).text.includes('Acme &lt;b&gt;'));
    assert.equal(seen.length, 11);
  });

  it('accepts a sign-in from its own pages and refuses one from elsewhere, including an opaque origin', async () => {
    const page = await new Client(base).get('/login');
    assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'no-referrer makes browsers send Origin: null on form posts');
    const post = (origin: string): Promise<number> =>
      new Client(base).post('/login', { email: 'staff@x.co', password: PASSWORD }, { origin }).then((r) => r.status);
    assert.equal(await post(base), 303);
    assert.equal(await post('http://evil.example'), 403);
    assert.equal(await post('null'), 403);
  });

  it('survives a malformed cookie and refuses unsupported methods', async () => {
    const c = new Client(base);
    c.cookie = 'qa_session=%E0%A4%A';
    assert.equal((await c.get('/')).location, '/login');
    const res = await fetch(`${base}/`, { method: 'DELETE', redirect: 'manual' });
    assert.equal(res.status, 405);
    assert.equal((await new Client(base).post('/team/new', { name: 'a' })).location, '/login', 'POST without a session goes to sign-in');
  });

  it('offers one-click role buttons on the showcase database only', async () => {
    assert.doesNotMatch((await new Client(base).get('/login')).text, /demo-pick/);
    repo.setMeta('demo', '1');
    assert.doesNotMatch((await new Client(base).get('/login')).text, /demo-pick/, 'needs the demo password too');
    repo.setMeta('demo_password', PASSWORD);
    const html = (await new Client(base).get('/login')).text;
    assert.match(html, /demo-pick/);
    assert.match(html, /Owner · Olive/);
    assert.match(html, /Viewer · Vik/);
    repo.setMeta('demo', '0');
    assert.doesNotMatch((await new Client(base).get('/login')).text, /demo-pick/);
  });
});

// --- branding -------------------------------------------------------------------------------------------------------------------

describe('branding', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
  const write = (name: string, content: string | Buffer): string => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, content);
    return f;
  };
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0f7b6c"/></svg>';
  const cfg = (over: Partial<ReturnType<typeof loadConfig>['brand']> = {}): ReturnType<typeof loadConfig>['brand'] => ({ name: 'Acme Quotes', logoPath: undefined, logoOnly: false, color: undefined, footer: undefined, ...over });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('keeps a readable accent and darkens one that is too light for white button text', () => {
    assert.equal(accentTokens('#0f7b6c').brand, '#0f7b6c');
    const light = accentTokens('#ffe066');
    assert.notEqual(light.brand, '#ffe066');
    const rgb = [1, 3, 5].map((i) => parseInt(light.brand.slice(i, i + 2), 16)) as [number, number, number];
    assert.ok(contrastWithWhite(rgb) >= 4.5, 'white text on the accent must be readable');
    assert.match(accentTokens('#0f7b6c').wash, /^#[0-9a-f]{6}$/);
  });

  it('uses the standard look when nothing is set, and layers the accent on top when it is', () => {
    const plain = loadBrand(cfg({ name: 'Quote assistant' }));
    assert.equal(plain.logo, null);
    assert.doesNotMatch(plain.css, /--brand:#0f7b6c/);
    const coloured = loadBrand(cfg({ color: '#0f7b6c' }));
    assert.match(coloured.css, /:root\{--brand:#0f7b6c;/);
    assert.notEqual(coloured.brand.cssHref, plain.brand.cssHref, 'a new design must get a new address so it is never served from a cached copy');
    assert.equal(loadBrand(undefined).brand.name, 'Quote assistant');
  });

  it('accepts a good logo and skips (with a warning) anything unsafe or unusable', () => {
    const ok = loadBrand(cfg({ logoPath: write('good.svg', SVG), logoOnly: true }));
    assert.equal(ok.logo?.type, 'image/svg+xml');
    assert.equal(ok.brand.logoOnly, true);
    assert.match(ok.brand.logoUrl ?? '', /^\/assets\/logo\?v=[0-9a-f]{8}$/);

    for (const [file, content, why] of [
      ['bad.exe', 'MZ', /\.png, \.jpg/],
      ['script.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', /script/],
      ['onload.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>', /script/],
      ['notsvg.svg', 'hello', /not an SVG/],
      ['empty.png', '', /between 1 byte/],
      ['huge.png', Buffer.alloc(1024 * 1024 + 1), /between 1 byte/],
    ] as const) {
      const r = loadBrand(cfg({ logoPath: write(file, content), logoOnly: true }));
      assert.equal(r.logo, null, file);
      assert.equal(r.brand.logoUrl, null, file);
      assert.equal(r.brand.logoOnly, false, 'logo-only means nothing without a logo');
      assert.match(r.warnings.join(' '), why, file);
    }
    assert.match(loadBrand(cfg({ logoPath: path.join(tmp, 'missing.png') })).warnings.join(' '), /BRAND_LOGO ignored/);
  });

  it('rejects a malformed colour in the settings', () => {
    assert.throws(() => loadConfig({ BRAND_COLOR: 'teal' }));
    assert.throws(() => loadConfig({ BRAND_COLOR: '#12345' }));
    assert.equal(loadConfig({ BRAND_COLOR: '#0F7B6C' }).brand.color, '#0f7b6c');
    assert.equal(loadConfig({}).brand.name, 'Quote assistant');
  });

  it('shows the name, logo, colour and footer on every page, escaped, and serves the logo without a login', async () => {
    const db2 = openDatabase(':memory:');
    const repo2 = new Repository(db2, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15 });
    const users2 = new UserStore(db2);
    users2.create({ email: 'o@x.co', name: 'Owner', role: 'owner', passwordHash: await hashed(), mustChangePassword: false });
    const config2 = loadConfig({
      AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'sales@example.com', CLIENT_NAME: 'Acme Industries',
      BRAND_NAME: 'Acme <Quotes>', BRAND_LOGO: write('server.svg', SVG), BRAND_COLOR: '#0f7b6c', BRAND_FOOTER: 'Powered by <SOWS>',
    });
    const server2 = createDashboardServer({ config: config2, repo: repo2, users: users2 });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server2.address() as { port: number }).port}`;
    try {
      const anon = new Client(url);
      const login = await anon.get('/login');
      assert.match(login.text, /<title>Sign in · Acme &lt;Quotes&gt;<\/title>/);
      assert.match(login.text, /<img class="logo" src="\/assets\/logo\?v=[0-9a-f]{8}"/);
      assert.match(login.text, /Powered by &lt;SOWS&gt;/);
      assert.doesNotMatch(login.text, /<SOWS>|<Quotes>/);
      assert.match(login.text, /rel="icon" href="data:image\/svg\+xml,/);

      const logo = await fetch(`${url}/assets/logo`);
      assert.equal(logo.status, 200);
      assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
      assert.match(logo.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
      const css = await (await fetch(`${url}/assets/app.css`)).text();
      assert.match(css, /--brand:#0f7b6c/);
      assert.match(css, /\.f-blue\{fill:var\(--blue\)\}/, 'chart colours stay on the validated palette');

      const c = new Client(url);
      assert.equal(await c.login('o@x.co'), 303);
      for (const p of ['/', '/enquiries', '/team', '/account', '/nowhere']) {
        const page = await c.get(p);
        assert.match(page.text, /<title>[^<]* · Acme &lt;Quotes&gt;<\/title>/, p);
        assert.match(page.text, /<img class="logo"/, p);
        assert.match(page.text, /class="brandfoot">Powered by &lt;SOWS&gt;/, p);
        assert.doesNotMatch(page.text, /Quote assistant/, `${p} still says the default name`);
        assert.doesNotMatch(page.text, /\sstyle="/, p);
      }
      assert.match((await c.get('/')).text, /<span>Acme &lt;Quotes&gt; <small>· Acme Industries<\/small><\/span>/);
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
      db2.close();
    }
  });

  it('without a logo configured there is no logo address, and the standard name shows', async () => {
    const db3 = openDatabase(':memory:');
    const repo3 = new Repository(db3, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15 });
    const users3 = new UserStore(db3);
    users3.create({ email: 'o@x.co', name: 'Owner', role: 'owner', passwordHash: await hashed(), mustChangePassword: false });
    const server3 = createDashboardServer({ config: loadConfig({ AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'sales@example.com' }), repo: repo3, users: users3 });
    await new Promise<void>((r) => server3.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server3.address() as { port: number }).port}`;
    try {
      assert.equal((await new Client(url).get('/assets/logo')).status, 303);
      const login = (await new Client(url).get('/login')).text;
      assert.match(login, /<title>Sign in · Quote assistant<\/title>/);
      assert.doesNotMatch(login, /class="logo"|brandfoot/);
    } finally {
      await new Promise<void>((r) => server3.close(() => r()));
      db3.close();
    }
  });
});

// --- "check before sending" list, and what the client is shown about AI cost ---------------------------------------------------

describe('flagged quotes and AI cost visibility', () => {
  const now = new Date('2026-10-21T10:00:00Z');

  it('lists only the quotes flagged for a second look, in the list and in the download', async () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    const users = new UserStore(db, () => now);
    users.create({ email: 'o@x.co', name: 'Owner', role: 'owner', passwordHash: await hashed(), mustChangePassword: false });
    const make = (key: string, flags?: string[]): void => {
      const c = repo.claim({ messageKey: key, contentHash: key, messageId: key, senderEmail: `${key}@cust.co`, subject: key, attachmentName: 'a.xlsx' });
      if (c.outcome !== 'claimed') throw new Error('claim failed');
      repo.recordEstimate(c.id, { customerId: 'c', estimateId: key, estimateNumber: `QT-${key}`, quoteUrl: 'https://books.zoho.in/x', totalAmount: 100, currencyCode: 'INR', lineCount: 1, matchedCount: 1, unmatchedCount: 0, customerName: key, ...(flags ? { reviewFlags: flags } : {}) });
      repo.finish(c.id, 'QUOTE_CREATED');
    };
    make('plain1');
    make('risky', ['LARGE_TOTAL']);
    make('plain2');
    const config = loadConfig({ AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'sales@example.com' });
    const server = createDashboardServer({ config, repo, users, clock: () => now });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const c = new Client(url);
      assert.equal(await c.login('o@x.co'), 303);
      const all = (await c.get('/enquiries?filter=all')).text;
      assert.match(all, /href="\/enquiries\?filter=flagged"[^>]*>Check before sending</);
      const flagged = (await c.get('/enquiries?filter=flagged')).text;
      assert.match(flagged, /1 enquiry in this view/);
      assert.match(flagged, /risky/);
      assert.doesNotMatch(flagged, /plain1|plain2/);
      const csv = (await c.get('/enquiries.csv?filter=flagged')).text;
      assert.match(csv, /risky/);
      assert.doesNotMatch(csv, /plain1|plain2/);
      assert.match(csv, /LARGE_TOTAL/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    }
  });

  it('keeps the AI cost off the client\'s screens unless it is switched on', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    repo.addLlmUsage('2026-10-20', 'email_extraction', 4, 4000, 400);
    const base = { AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'sales@example.com' };
    const off = overview(repo, loadConfig(base), '7d', now);
    assert.equal(loadConfig(base).dashboard.showAiCost, false);
    assert.ok(!off.chips.some((c) => /AI cost/.test(c.label)), 'hidden by default');
    const on = overview(repo, loadConfig({ ...base, SHOW_AI_COST: 'true' }), '7d', now);
    assert.ok(on.chips.some((c) => /AI cost/.test(c.label)), 'shown when asked for');
    db.close();
  });
});

describe('savings shown to the client', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const seed = (): { db: ReturnType<typeof openDatabase>; repo: Repository } => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db, { dedupeWindowHours: 48, maxAttempts: 5, staleProcessingMinutes: 15, now: () => now });
    for (const key of ['a', 'b']) {
      const c = repo.claim({ messageKey: key, contentHash: key, messageId: key, senderEmail: `${key}@c.co`, subject: key, attachmentName: 'x.xlsx' });
      if (c.outcome !== 'claimed') throw new Error('claim failed');
      repo.recordEstimate(c.id, { customerId: 'c', estimateId: key, estimateNumber: key, quoteUrl: 'https://books.zoho.in/x', totalAmount: 1000, currencyCode: 'INR', lineCount: 5, matchedCount: 5, unmatchedCount: 0, customerName: key });
      repo.finish(c.id, 'QUOTE_CREATED');
    }
    return { db, repo };
  };
  const base = { AGENT_DB_PATH: ':memory:', NOTIFY_INTERNAL_EMAIL: 'sales@example.com' };

  it('turns hours saved into money at the client\'s own hourly figure, and says which figure it used', () => {
    const { db, repo } = seed();
    // 2 drafts x (10 min + 5 lines x 2 min) = 40 minutes
    const m = overview(repo, loadConfig({ ...base, STAFF_COST_PER_HOUR: '300' }), '7d', now);
    assert.equal(m.hero.minutes, 40);
    const chip = m.chips[0];
    assert.match(chip?.label ?? '', /of staff time saved, at .*300.* an hour/);
    assert.match(chip?.value ?? '', /200/, '40 minutes at 300 an hour is 200');
    db.close();
  });

  it('shows no money figure unless an hourly cost is set', () => {
    const { db, repo } = seed();
    const m = overview(repo, loadConfig(base), '7d', now);
    assert.ok(!m.chips.some((c) => /staff time/.test(c.label)));
    assert.equal(loadConfig(base).roi.staffCostPerHour, undefined);
    assert.throws(() => loadConfig({ ...base, STAFF_COST_PER_HOUR: '-5' }));
    db.close();
  });

  it('puts the same figure in the morning summary data', () => {
    const { db, repo } = seed();
    const cfg = loadConfig({ ...base, STAFF_COST_PER_HOUR: '300' });
    const s = buildDailySummary(repo, cfg, now);
    assert.equal(s.timeSavedMinutes, 40);
    assert.deepEqual(s.timeSavedValue, { amount: 200, currency: 'INR' });
    assert.equal(buildDailySummary(repo, loadConfig(base), now).timeSavedValue, undefined);
    db.close();
  });
});

describe('mailbox pre-flight messages', () => {
  const say = (err: object, what: 'IMAP' | 'SMTP' = 'IMAP', host = 'imappro.zoho.in'): string => explainConnectionError(err, what, host);

  it('says what to do for the failures people actually hit', () => {
    assert.match(say({ code: 'ENOTFOUND' }), /was not found.*IMAP_HOST/);
    assert.match(say({ code: 'EDNS', message: 'getaddrinfo ENOTFOUND x' }, 'SMTP', 'x'), /was not found.*SMTP_HOST/);
    assert.match(say({ code: 'ECONNREFUSED' }, 'SMTP', 'h'), /Could not reach h.*SMTP_PORT.*587/);
    assert.match(say({ code: 'ETIMEDOUT' }), /Could not reach.*993/);
    assert.match(say({ authenticationFailed: true, response: 'Invalid credentials' }), /refused the login.*IMAP access.*app password|app-specific/is);
    assert.match(say({ code: 'EAUTH', response: '535 Authentication failed' }, 'SMTP', 'smtppro.zoho.in'), /refused the login.*Zoho Accounts/s);
    assert.match(say({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), /certificate/);
  });

  it('tells Gmail users to use an app password', () => {
    const msg = say({ code: 'EAUTH', response: '535-5.7.8 Username and Password not accepted' }, 'SMTP', 'smtp.gmail.com');
    assert.match(msg, /refused the login/);
    assert.match(msg, /App passwords/);
    assert.doesNotMatch(msg, /Zoho/);
  });

  it('only mentions Zoho settings for Zoho hosts, and falls back to the raw message otherwise', () => {
    assert.doesNotMatch(say({ authenticationFailed: true }, 'IMAP', 'imap.gmail.com'), /Zoho/);
    assert.equal(say(new Error('something odd'), 'IMAP', 'h'), 'something odd');
  });
});

