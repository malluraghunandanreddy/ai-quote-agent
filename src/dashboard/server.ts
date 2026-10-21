import crypto from 'node:crypto';
import http from 'node:http';
import { assignableRoles, can, canManage, isRole, roleLabel, type Permission } from '../auth/rbac';
import { GSTIN, canonicalState, type CustomerDraft } from '../llm/customerExtractor';
import { addCustomer } from '../zoho/customerCreate';
import type { ZohoApi } from '../types';
import { generatePassword, hashPassword, looksLikeEmail, passwordProblem, spendCheckTime, verifyPassword } from '../auth/passwords';
import type { Config } from '../config';
import type { Repository } from '../db/repository';
import { NoteStore, UserError, UserStore, type User } from '../db/users';
import { errorMessage, logger } from '../logger';
import { computeHealth } from '../ops/monitor';
import { loadBrand } from './brand';
import { accountPage, activityPage, ACTIVITY_FILTERS, forcedPasswordPage, loginPage, personPage, teamPage, type Flash, type LoginOptions } from './adminPages';
import { APP_JS } from './assets';
import { COOKIE, LoginLimiter, parseCookies } from './auth';
import { chrome, exportCsv, listing, overview, parseRange } from './data';
import { dataPage, enquiriesPage, enquiryPage, messagePage, overviewPage, statusPage } from './pages';
import type { Viewer } from './views';

export interface DashboardDeps {
  config: Config;
  repo: Repository;
  clock?: () => Date;
  /** Shared with the caller when it needs to create the first owner; made from the repository's database otherwise. */
  users?: UserStore;
  notes?: NoteStore;
  /** The Zoho Books connection, so an approved new customer can be added from an enquiry. Without it the button is not offered. */
  zoho?: { api: ZohoApi; organizationId: string };
}

const SECURITY_HEADERS: Record<string, string> = {
  // Everything (style, script) is served from the dashboard's own address; nothing from elsewhere, no inline styles.
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Not no-referrer: browsers then send `Origin: null` on form posts, which the same-site check could not tell from an attack.
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

type Extra = Record<string, string | string[]>;

function send(res: http.ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Extra = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function redirect(res: http.ServerResponse, to: string, extra: Extra = {}): void {
  res.writeHead(303, { ...SECURITY_HEADERS, Location: to, 'Cache-Control': 'no-store', ...extra });
  res.end();
}

async function readForm(req: http.IncomingMessage, maxBytes = 8192): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const safeEqual = (a: string, b: string): boolean => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

const SAVED: Record<string, string> = {
  note: 'Note saved.',
  handled: 'Marked as handled.',
  reopened: 'Reopened.',
  customer: 'Customer added to Zoho Books. The quote is created automatically within a couple of minutes.',
  customer_exists: 'That customer is already in Zoho Books. The quote is created automatically within a couple of minutes.',
  customer_resend: 'Customer added to Zoho Books. This email is no longer being kept, so ask the sender to resend it and it will be quoted straight away.',
};

/** Read and check the "add customer" form. Returns what the person typed, and what is wrong with it. */
function readCustomerForm(f: URLSearchParams): { values: CustomerDraft; errors: string[] } {
  const get = (k: string, max: number): string => (f.get(k) ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const values: CustomerDraft = { companyName: get('company', 100), contactName: get('contact', 80), email: get('email', 254), phone: get('phone', 20), address: get('address', 200), city: get('city', 60), state: canonicalState(get('state', 40)), zip: get('zip', 6), gstin: get('gstin', 15).toUpperCase(), source: 'rules' };
  const errors: string[] = [];
  if (!values.companyName) errors.push('Please enter the company name.');
  if (values.email && !looksLikeEmail(values.email)) errors.push('That email address does not look right.');
  if (values.phone && !/^[+\d][\d\s().-]{5,19}$/.test(values.phone)) errors.push('The phone number may only contain digits, spaces, + and -.');
  if (values.zip && !/^\d{6}$/.test(values.zip)) errors.push('The PIN code must be 6 digits.');
  if (values.gstin && !GSTIN.test(values.gstin)) errors.push('That GST number does not look right (15 characters, for example 37ABCDE1234F1Z5).');
  return { values, errors };
}
const DENIED_TITLE = 'Not available for your role';

/**
 * The dashboard: per-person sign-in, four roles (see auth/rbac.ts), and pages for the overview, enquiries (with team
 * notes), status, team, activity and each person's own account. It never changes a quote, sends an email or touches
 * Zoho: the only things it writes are logins, notes and its own activity log, all in the local database.
 */
export function createDashboardServer(deps: DashboardDeps): http.Server {
  const { config, repo } = deps;
  const clock = deps.clock ?? (() => new Date());
  const users = deps.users ?? new UserStore(repo.database, clock);
  const notes = deps.notes ?? new NoteStore(repo.database, clock);
  const limiter = new LoginLimiter();
  const loaded = loadBrand(config.brand);
  const brand = loaded.brand;
  for (const w of loaded.warnings) logger.warn(w);
  /** Pages that have no signed-in person still carry the brand. */
  const msg = (title: string, message: string, viewer?: Viewer): string => messagePage(title, message, viewer, brand);

  const clientIp = (req: http.IncomingMessage): string =>
    (config.dashboard.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '') || req.socket.remoteAddress || 'unknown';
  const isHttps = (req: http.IncomingMessage): boolean =>
    Boolean((req.socket as { encrypted?: boolean }).encrypted) || (config.dashboard.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const sameOrigin = (req: http.IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = (config.dashboard.trustProxy ? req.headers['x-forwarded-host'] : undefined) ?? req.headers.host;
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };
  const cookie = (req: http.IncomingMessage, value: string, maxAge: number): string =>
    `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  const signInUrl = (req: http.IncomingMessage): string => config.dashboard.publicUrl ?? `${isHttps(req) ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;

  /** One-click role switching on the showcase database only (it has a `demo_password` that the seeding wrote). */
  function demoLogins(): LoginOptions['demoLogins'] {
    const password = repo.getMeta('demo_password');
    if (repo.getMeta('demo') !== '1' || !password) return undefined;
    const out: NonNullable<LoginOptions['demoLogins']> = [];
    for (const role of ['owner', 'manager', 'staff', 'viewer'] as const) {
      const u = users.list().find((x) => x.role === role && x.active);
      if (u) out.push({ role, name: u.name, email: u.email, password });
    }
    return out;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dashboard.local');
    const path = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    const now = clock();
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    // --- public ---------------------------------------------------------------------------------------------------
    if (path === '/healthz') {
      const h = computeHealth(repo, config, now);
      const reason = h.ok ? undefined : h.consecutiveFailures >= config.alerts.failuresBeforeAlert ? 'mailbox_checks_failing' : 'no_recent_check';
      return send(res, h.ok ? 200 : 503, JSON.stringify({ status: h.ok ? 'ok' : 'unhealthy', ...(reason ? { reason } : {}), lastCheckOkAt: h.lastPollOkAt ?? null }), 'application/json; charset=utf-8');
    }
    if (path === '/assets/app.css') return send(res, 200, loaded.css, 'text/css; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
    if (path === '/assets/logo' && loaded.logo) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': loaded.logo.type, 'Content-Length': loaded.logo.body.length, 'Cache-Control': 'public, max-age=3600' });
      return void res.end(method === 'GET' && req.method !== 'HEAD' ? loaded.logo.body : undefined);
    }
    if (path === '/assets/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });

    if (method !== 'GET' && method !== 'POST') return send(res, 405, msg('Not allowed', 'That request type is not supported.'));
    if (users.count() === 0) {
      return send(res, 503, msg('The dashboard is not set up yet', 'Nobody has a login yet. Ask support to create the first owner login. Quotes are still being created normally.'));
    }

    // --- sign in / out ----------------------------------------------------------------------------------------------
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = users.sessionFor(token);
    const ip = clientIp(req);

    if (path === '/login') {
      if (method === 'GET') return session ? redirect(res, '/') : send(res, 200, loginPage(config.dashboard.clientName, { brand, demoLogins: demoLogins() }));
      if (!sameOrigin(req)) return send(res, 403, msg('Not allowed', 'That request came from a different site.'));
      if (limiter.blocked(ip, now.getTime())) return send(res, 429, loginPage(config.dashboard.clientName, { brand, error: 'Too many wrong attempts from this device. Please wait 15 minutes and try again.' }));
      const form = await readForm(req);
      const email = (form?.get('email') ?? '').trim().toLowerCase().slice(0, 254);
      const password = (form?.get('password') ?? '').slice(0, 1000);
      const found = email ? users.credentials(email) : undefined;
      const usable = Boolean(found && found.user.active && !users.isLocked(found.user));
      let ok = false;
      if (found && usable) ok = await verifyPassword(password, found.hash);
      else await spendCheckTime(password); // same time whether or not the account exists
      if (ok && found) {
        limiter.clear(ip);
        users.recordSuccess(found.user.id);
        users.purgeExpiredSessions();
        const made = users.createSession(found.user.id, { ip, userAgent: req.headers['user-agent'] });
        users.logEvent({ actor: { id: found.user.id, name: found.user.name }, event: 'login', ip });
        return redirect(res, '/', { 'Set-Cookie': cookie(req, made.token, made.maxAgeSeconds) });
      }
      limiter.fail(ip, now.getTime());
      if (found && usable) {
        const { locked } = users.recordFailure(found.user.id);
        users.logEvent({ actorLabel: 'Someone', event: locked ? 'login_locked' : 'login_failed', target: found.user.email, ip });
      } else if (email) {
        users.logEvent({ actorLabel: 'Someone', event: 'login_failed', target: email, ip });
      }
      await new Promise((r) => setTimeout(r, 250)); // makes guessing slower, costs a real user nothing
      return send(res, 401, loginPage(config.dashboard.clientName, { brand, error: 'That email and password do not match, or the login is paused. After 5 wrong tries a login pauses for 15 minutes.', email, demoLogins: demoLogins() }));
    }
    if (path === '/logout' && method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, msg('Not allowed', 'That request came from a different site.'));
      if (session) users.logEvent({ actor: { id: session.user.id, name: session.user.name }, event: 'logout', ip });
      users.deleteSession(token);
      return redirect(res, '/login', { 'Set-Cookie': cookie(req, '', 0) });
    }

    // --- everything below needs a person -------------------------------------------------------------------------------
    if (!session) return redirect(res, '/login');
    const me: User = session.user;
    const viewer: Viewer = { id: me.id, name: me.name, email: me.email, role: me.role, csrf: session.csrf };
    const actor = { id: me.id, name: me.name };

    let form: URLSearchParams | null = null;
    if (method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, msg('Not allowed', 'That request came from a different site.', viewer));
      form = await readForm(req);
      if (!form) return send(res, 413, msg('That was too much text', 'Please shorten it and try again.', viewer));
      if (!safeEqual(form.get('_csrf') ?? '', session.csrf)) return send(res, 403, msg('Please try again', 'That page was open for too long or came from somewhere else. Go back, refresh it and try again.', viewer));
    }
    const f = form ?? new URLSearchParams();

    // A new person must choose their own password before anything else.
    if (me.mustChangePassword && path !== '/account/password') return redirect(res, '/account/password');

    const clientName = config.dashboard.clientName;
    const tz = config.timezone;
    const page = chrome(repo, config, now);
    const common = { clientName, viewer, brand, demo: page.demo, live: page.live, ...(page.banner ? { banner: page.banner } : {}) };
    const base = { ...common, tz, now };

    const deny = (what: string): void => {
      users.logEvent({ actor, event: 'access_denied', target: what, ip });
      send(res, 403, msg(DENIED_TITLE, `Your role (${roleLabel(me.role)}) does not include this. Ask a manager or an owner if you need it.`, viewer));
    };
    const need = (permission: Permission): boolean => {
      if (can(me.role, permission)) return true;
      deny(path);
      return false;
    };
    const enquiryLabel = (id: number): string => {
      const e = repo.get(id);
      return `Enquiry #${id}${e ? ` (${e.customerName || e.companyInEmail || e.senderEmail})` : ''}`;
    };

    // --- your account (any role) -------------------------------------------------------------------------------------
    if (path === '/account/password') {
      if (method === 'GET') return me.mustChangePassword ? send(res, 200, forcedPasswordPage({ clientName, viewer, brand })) : redirect(res, '/account');
      const fail = (error: string): void => {
        if (me.mustChangePassword) send(res, 400, forcedPasswordPage({ clientName, viewer, brand, error }));
        else send(res, 400, accountPage({ ...base, user: me, sessions: users.sessionsFor(me.id), currentSessionId: session.sessionId, flash: { kind: 'bad', text: error } }));
      };
      const creds = users.credentials(me.email);
      if (!creds || !(await verifyPassword(f.get('current') ?? '', creds.hash))) {
        const { locked } = users.recordFailure(me.id);
        if (locked) users.logEvent({ actorLabel: 'Someone', event: 'login_locked', target: me.email, ip });
        return fail('The current password is not right.');
      }
      const next = f.get('password') ?? '';
      if (next !== (f.get('confirm') ?? '')) return fail('The two new passwords are not the same.');
      if (next === (f.get('current') ?? '')) return fail('Please choose a password different from the current one.');
      const problem = passwordProblem(next, { email: me.email, name: me.name });
      if (problem) return fail(problem);
      users.setPassword(me.id, await hashPassword(next), false, session.sessionId);
      users.logEvent({ actor, event: 'password_changed', ip });
      return me.mustChangePassword ? redirect(res, '/') : redirect(res, '/account?saved=password');
    }
    if (path === '/account/name' && method === 'POST') {
      try {
        users.setName(me.id, f.get('name') ?? '');
      } catch (err) {
        if (err instanceof UserError) return send(res, 400, accountPage({ ...base, user: me, sessions: users.sessionsFor(me.id), currentSessionId: session.sessionId, flash: { kind: 'bad', text: err.message } }));
        throw err;
      }
      users.logEvent({ actor, event: 'name_changed', ip });
      return redirect(res, '/account?saved=name');
    }
    if (path === '/account/signout-others' && method === 'POST') {
      const n = users.deleteSessionsFor(me.id, session.sessionId);
      users.logEvent({ actor, event: 'sessions_revoked', detail: `${n} device${n === 1 ? '' : 's'}`, ip });
      return redirect(res, '/account?saved=others');
    }
    if (path === '/account' && method === 'GET') {
      const saved = url.searchParams.get('saved');
      const text = saved === 'password' ? 'Password changed. Your other devices were signed out.' : saved === 'name' ? 'Name saved.' : saved === 'others' ? 'Your other devices were signed out.' : '';
      const flash: Flash | undefined = text ? { kind: 'ok', text } : undefined;
      return send(res, 200, accountPage({ ...base, user: me, sessions: users.sessionsFor(me.id), currentSessionId: session.sessionId, ...(flash ? { flash } : {}) }));
    }

    // --- enquiry notes (staff and up) ----------------------------------------------------------------------------------
    const enquiryView = (id: number, flash?: { text: string; error?: boolean }, form?: CustomerDraft): string => {
      const e = repo.get(id)!;
      const needsCustomer = e.status === 'HALTED_CUSTOMER_NOT_FOUND';
      const addedAt = repo.auditTrail(id).filter((a) => a.event === 'CUSTOMER_ADDED').map((a) => Date.parse(a.at)).sort((a, b) => b - a)[0];
      const addedRecently = addedAt !== undefined && now.getTime() - addedAt < 15 * 60_000 && !form;
      const customerForm = needsCustomer && !notes.isHandled(id)
        ? { addedRecently, values: form ?? e.customerDraft ?? { companyName: e.companyInEmail ?? '', contactName: '', email: e.senderEmail, phone: '', address: '', city: '', state: '', zip: '', gstin: '', source: 'rules' as const }, canCreate: can(me.role, 'customers.create'), available: Boolean(deps.zoho), held: e.holdUntil !== null }
        : undefined;
      return enquiryPage({ ...common, e, audit: repo.auditTrail(e.id), notices: repo.notificationsFor(e.id), notes: notes.forEnquiry(e.id), handled: notes.isHandled(e.id), ...(flash ? { flash: flash.text } : {}), ...(flash?.error ? { flashBad: true } : {}), ...(customerForm ? { customerForm } : {}), tz, now });
    };

    // --- add the new customer to Zoho Books, after a person has checked the details ------------------------------------
    const addRoute = /^\/enquiry\/(\d{1,9})\/customer$/.exec(path);
    if (addRoute && method === 'POST') {
      if (!need('customers.create')) return;
      const id = Number(addRoute[1]);
      const e = repo.get(id);
      if (!e) return send(res, 404, msg('Enquiry not found', 'It may have been removed after the retention period.', viewer));
      if (!deps.zoho) return send(res, 503, enquiryView(id, { text: 'Adding customers from here needs the quote service to be running with its Zoho Books connection. Add the customer in Zoho Books instead.', error: true }, readCustomerForm(f).values));
      if (e.status !== 'HALTED_CUSTOMER_NOT_FOUND') return redirect(res, `/enquiry/${id}`);
      const { values, errors } = readCustomerForm(f);
      if (errors.length > 0) return send(res, 400, enquiryView(id, { text: errors.join(' '), error: true }, values));
      const added = await addCustomer(deps.zoho.api, deps.zoho.organizationId, values, `Added from an enquiry by the quote assistant, approved by ${me.name} on ${now.toISOString().slice(0, 10)}.`);
      if (added.status === 'failed') {
        users.logEvent({ actor, event: 'customer_add_failed', target: enquiryLabel(id), detail: added.message, ip });
        return send(res, 502, enquiryView(id, { text: `Zoho Books did not accept the customer: ${added.message}`, error: true }, values));
      }
      repo.clearCustomerDraft(id);
      repo.makeHeldDue(id);
      repo.audit(id, 'CUSTOMER_ADDED', `${added.name}: ${added.status === 'created' ? 'added to Zoho Books' : 'already in Zoho Books'}, approved by ${me.name}`);
      users.logEvent({ actor, event: 'customer_added', target: enquiryLabel(id), detail: `${added.name} (${added.status === 'created' ? 'added to Zoho Books' : 'already there'})`, ip });
      return redirect(res, `/enquiry/${id}?saved=${added.status === 'exists' ? 'customer_exists' : e.holdUntil ? 'customer' : 'customer_resend'}`);
    }

    const act = /^\/enquiry\/(\d{1,9})\/(note|handled|reopen)$/.exec(path);
    if (act && method === 'POST') {
      if (!need('enquiries.annotate')) return;
      const id = Number(act[1]);
      if (!repo.get(id)) return send(res, 404, msg('Enquiry not found', 'It may have been removed after the retention period.', viewer));
      const body = (f.get('body') ?? '').trim();
      const kind = act[2] === 'note' ? 'note' : act[2] === 'handled' ? 'handled' : 'reopened';
      if (kind === 'note' && !body) return redirect(res, `/enquiry/${id}?saved=empty`);
      notes.add(id, actor, kind, body);
      users.logEvent({ actor, event: kind === 'note' ? 'note_added' : kind === 'handled' ? 'marked_handled' : 'reopened', target: enquiryLabel(id), ip });
      return redirect(res, `/enquiry/${id}?saved=${kind}`);
    }

    // --- team (manager and up) ----------------------------------------------------------------------------------------------
    if (path === '/team/new' && method === 'POST') {
      if (!need('team.manage')) return;
      const name = (f.get('name') ?? '').trim();
      const email = (f.get('email') ?? '').trim().toLowerCase();
      const roleValue = f.get('role') ?? '';
      const draft = { name, email, role: roleValue };
      const again = (status: number, text: string): void => send(res, status, teamPage({ ...base, people: users.list(), flash: { kind: 'bad', text }, draft }));
      if (!name || name.length > 80) return again(400, 'Please enter their name (up to 80 characters).');
      if (!looksLikeEmail(email)) return again(400, 'Please enter a valid email address. It is what they will sign in with.');
      if (!isRole(roleValue) || !assignableRoles(me.role).includes(roleValue)) return again(403, `Your role (${roleLabel(me.role)}) cannot give that role.`);
      const temp = generatePassword();
      try {
        const created = users.create({ email, name, role: roleValue, passwordHash: await hashPassword(temp), mustChangePassword: true, createdBy: me.id });
        users.logEvent({ actor, event: 'user_created', target: created.email, detail: roleLabel(created.role), ip });
        return send(res, 200, personPage({ ...base, person: created, tempPassword: temp, signInUrl: signInUrl(req), flash: { kind: 'ok', text: `${created.name} now has a login.` } }));
      } catch (err) {
        if (err instanceof UserError) return again(409, err.message);
        throw err;
      }
    }
    const teamAct = /^\/team\/(\d{1,9})(?:\/(role|active|reset|unlock))?$/.exec(path);
    if (path === '/team' && method === 'GET') {
      if (!need('team.view')) return;
      const saved = url.searchParams.get('saved');
      return send(res, 200, teamPage({ ...base, people: users.list(), ...(saved ? { flash: { kind: 'ok' as const, text: saved } } : {}) }));
    }
    if (teamAct) {
      if (!need('team.manage')) return;
      const target = users.get(Number(teamAct[1]));
      if (!target) return send(res, 404, msg('Person not found', 'That login does not exist.', viewer));
      if (target.id === me.id) return redirect(res, '/account');
      if (!canManage(me.role, target.role)) return deny(path);
      const render = (status: number, flash?: Flash, tempPassword?: string): void =>
        send(res, status, personPage({ ...base, person: users.get(target.id) ?? target, signInUrl: signInUrl(req), ...(flash ? { flash } : {}), ...(tempPassword ? { tempPassword } : {}) }));
      const action = teamAct[2];
      if (method === 'GET') return action ? send(res, 405, msg('Not allowed', 'Use the buttons on the person\'s page.', viewer)) : render(200);
      try {
        if (action === 'role') {
          const next = f.get('role') ?? '';
          if (!isRole(next) || !assignableRoles(me.role).includes(next)) return render(403, { kind: 'bad', text: `Your role (${roleLabel(me.role)}) cannot give that role.` });
          if (next !== target.role) {
            users.setRole(target.id, next);
            users.logEvent({ actor, event: 'role_changed', target: target.email, detail: `${roleLabel(target.role)} → ${roleLabel(next)}`, ip });
          }
          return render(200, { kind: 'ok', text: `${target.name} is now ${roleLabel(next)}.` });
        }
        if (action === 'active') {
          const on = f.get('active') === '1';
          users.setActive(target.id, on);
          users.logEvent({ actor, event: on ? 'user_reactivated' : 'user_deactivated', target: target.email, ip });
          return render(200, { kind: 'ok', text: on ? `${target.name} can sign in again.` : `${target.name} was signed out and can no longer sign in.` });
        }
        if (action === 'reset') {
          const temp = generatePassword();
          users.setPassword(target.id, await hashPassword(temp), true);
          users.logEvent({ actor, event: 'password_reset', target: target.email, ip });
          return render(200, { kind: 'ok', text: 'Password reset. They were signed out everywhere.' }, temp);
        }
        if (action === 'unlock') {
          users.unlock(target.id);
          users.logEvent({ actor, event: 'user_unlocked', target: target.email, ip });
          return render(200, { kind: 'ok', text: `${target.name} can try signing in again.` });
        }
      } catch (err) {
        if (err instanceof UserError) return render(409, { kind: 'bad', text: err.message });
        throw err;
      }
      return send(res, 404, msg('Page not found', 'That page does not exist. Use the menu at the top.', viewer));
    }

    // --- read-only pages --------------------------------------------------------------------------------------------------
    if (method !== 'GET') return send(res, 405, msg('Not allowed', 'That action does not exist.', viewer));

    if (path === '/') {
      if (!need('overview.view')) return;
      return send(res, 200, overviewPage(overview(repo, config, parseRange(url.searchParams.get('range')), now, notes.handledIds()), config, now, viewer, brand));
    }
    if (path === '/enquiries') {
      if (!need('enquiries.view')) return;
      const l = listing(repo, url.searchParams.get('filter') ?? 'all', Number(url.searchParams.get('page') ?? 1));
      return send(res, 200, enquiriesPage({ ...common, rows: l.rows, total: l.total, filter: l.filter, page: l.page, pages: l.pages, tz, now, canExport: can(me.role, 'enquiries.export') }));
    }
    if (path === '/enquiries.csv') {
      if (!need('enquiries.export')) return;
      const out = exportCsv(repo, url.searchParams.get('filter') ?? 'all', tz);
      users.logEvent({ actor, event: 'export', detail: `${out.rows} rows, ${out.filter}`, ip });
      return send(res, 200, out.body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${out.filename}"` });
    }
    const detail = /^\/enquiry\/(\d{1,9})$/.exec(path);
    if (detail) {
      if (!need('enquiries.view')) return;
      const e = repo.get(Number(detail[1]));
      if (!e) return send(res, 404, msg('Enquiry not found', 'It may have been removed after the retention period.', viewer));
      const saved = url.searchParams.get('saved') ?? '';
      const flash = saved === 'empty' ? 'Please write something before saving a note.' : SAVED[saved];
      return send(res, 200, enquiryView(e.id, flash ? { text: flash } : undefined));
    }
    if (path === '/status') {
      if (!need('status.view')) return;
      const started = repo.getMeta('started_at');
      return send(res, 200, statusPage({ ...common, config, services: page.services, now, ...(started ? { startedAt: started } : {}) }));
    }
    if (path === '/activity') {
      if (!need('activity.view')) return;
      const filter = ACTIVITY_FILTERS.find((x) => x.key === url.searchParams.get('filter')) ?? ACTIVITY_FILTERS[0]!;
      const pageNo = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? 1)) || 1);
      const size = 30;
      const out = users.events({ ...(filter.kinds ? { kinds: filter.kinds } : {}), limit: size, offset: (pageNo - 1) * size });
      return send(res, 200, activityPage({ ...base, events: out.rows, total: out.total, filter: filter.key, page: pageNo, pages: Math.max(1, Math.ceil(out.total / size)) }));
    }
    if (path === '/data') return send(res, 200, dataPage({ ...common, config }));
    return send(res, 404, msg('Page not found', 'That page does not exist. Use the menu at the top.', viewer));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error('Dashboard request failed', { path: req.url, error: errorMessage(err) });
      if (!res.headersSent) send(res, 500, msg('Something went wrong', 'Please refresh. If it keeps happening, tell support.'));
      else res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export function startDashboard(deps: DashboardDeps): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const server = createDashboardServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.dashboard.port, deps.config.dashboard.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : deps.config.dashboard.port;
      resolve({ server, port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
