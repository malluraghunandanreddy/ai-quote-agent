import { PERMISSIONS, PERMISSION_TEXT, ROLES, ROLE_INFO, assignableRoles, can, canManage, roleLabel, type Role } from '../auth/rbac';
import type { SecurityEvent, SessionInfo, User } from '../db/users';
import { describeDevice } from './auth';
import type { OverviewModel } from './data';
import { esc, fmtDateTime, initials, relTime } from './format';
import { DEFAULT_BRAND, type Brand } from './brand';
import { brandLabel, brandMark, csrfField, layout, roleChip, type Viewer } from './views';

type Live = OverviewModel['live'];
type Banner = OverviewModel['banner'];

export interface PageBase {
  clientName: string;
  viewer: Viewer;
  brand?: Brand;
  demo: boolean;
  live: Live;
  banner?: Banner;
  tz: string;
  now: Date;
}

export type Flash = { kind: 'ok' | 'bad'; text: string };
const flashHtml = (f?: Flash): string => (f ? `<p class="${f.kind === 'ok' ? 'okmsg' : 'badmsg'}" role="${f.kind === 'ok' ? 'status' : 'alert'}">${esc(f.text)}</p>` : '');

function wrap(o: PageBase, active: Parameters<typeof layout>[0]['active'], title: string, body: string): string {
  return layout({ title, active, clientName: o.clientName, viewer: o.viewer, ...(o.brand ? { brand: o.brand } : {}), demo: o.demo, live: o.live, ...(o.banner ? { banner: o.banner } : {}), body });
}

const tick = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const dash = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// --- sign in -------------------------------------------------------------------------------------------------------------

export interface LoginOptions {
  brand?: Brand;
  error?: string;
  notice?: string;
  email?: string;
  /** Demo database only: one-click sign-in for each role, so a showcase can switch between them. */
  demoLogins?: Array<{ role: Role; name: string; email: string; password: string }>;
}

export function loginPage(clientName: string, o: LoginOptions = {}): string {
  const demo = o.demoLogins?.length
    ? `<div class="demo-pick"><p><b>Showcase:</b> sign in as a team member to see what each role gets.</p><div class="row-btns">${o.demoLogins
        .map((d) => `<form method="post" action="/login"><input type="hidden" name="email" value="${esc(d.email)}"><input type="hidden" name="password" value="${esc(d.password)}"><button class="btn ghost sm" type="submit">${esc(roleLabel(d.role))} · ${esc(d.name.split(' ')[0] ?? d.name)}</button></form>`)
        .join('')}</div></div>`
    : '';
  const brand = o.brand ?? DEFAULT_BRAND;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light"><title>Sign in · ${esc(brand.name)}</title><link rel="icon" href="${esc(brand.faviconHref)}"><link rel="stylesheet" href="${esc(brand.cssHref)}"></head>
<body><div class="login"><div class="side"><div class="brand">${brandMark(brand)}${brandLabel(brand)}</div>
<div><h1>Enquiries in.<br>Draft quotes out.</h1><p>See what the assistant did with every email, what needs your team, and how much time it saved.</p></div><div class="sub">${clientName ? esc(clientName) : 'Your quote desk'}</div></div>
<div class="col"><form class="form" method="post" action="/login" autocomplete="on"><h2 class="lh">Sign in</h2>${o.notice ? `<p class="okmsg" role="status">${esc(o.notice)}</p>` : ''}${o.error ? `<p class="badmsg" role="alert">${esc(o.error)}</p>` : ''}
<label for="em">Email</label><input id="em" name="email" type="email" required autofocus autocomplete="username" spellcheck="false" value="${esc(o.email ?? '')}">
<label for="pw">Password</label><input id="pw" name="password" type="password" required autocomplete="current-password">
<button class="btn wide" type="submit">Open the dashboard</button><p class="sub p8">Forgot your password? Ask your manager or the account owner to reset it for you.</p></form>${demo}${brand.footer ? `<p class="brandfoot">${esc(brand.footer)}</p>` : ''}</div></div></body></html>`;
}

/** Shown instead of the app until a new person has chosen their own password. */
export function forcedPasswordPage(o: { clientName: string; viewer: Viewer; brand?: Brand; error?: string }): string {
  const body = `<div class="msg"><h1 class="pt">Choose your own password</h1><p class="sub lead">Hello ${esc(o.viewer.name)}. The password you were given is only for your first visit. Pick one that only you know, then you can carry on.</p>
<section class="panel mt"><form class="form" method="post" action="/account/password">${csrfField(o.viewer)}${o.error ? `<p class="badmsg" role="alert">${esc(o.error)}</p>` : ''}
<label for="cur">The password you were given</label><input id="cur" name="current" type="password" required autocomplete="current-password">
<label for="np">New password</label><input id="np" name="password" type="password" required minlength="10" autocomplete="new-password"><p class="hint">At least 10 characters. A few words in a row is easy to remember and hard to guess.</p>
<label for="np2">New password again</label><input id="np2" name="confirm" type="password" required minlength="10" autocomplete="new-password">
<div class="actions"><button class="btn" type="submit">Save and continue</button></div></form></section></div>`;
  return layout({ title: 'Choose a password', active: '', clientName: o.clientName, ...(o.brand ? { brand: o.brand } : {}), body });
}

// --- team ----------------------------------------------------------------------------------------------------------------------

function userStatus(u: User, now: Date, tz: string): string {
  if (!u.active) return `<span class="st neutral">Switched off</span>`;
  if (u.lockedUntil && u.lockedUntil > now.toISOString()) return `<span class="st warn">Paused until ${esc(fmtDateTime(u.lockedUntil, tz).split(', ').pop() ?? '')}</span>`;
  if (u.mustChangePassword) return `<span class="st neutral">Waiting for first sign-in</span>`;
  return `<span class="st good">Active</span>`;
}

function rolesTable(): string {
  const head = ROLES.slice()
    .reverse()
    .map((r) => `<th scope="col">${roleChip(r)}</th>`)
    .join('');
  const rows = PERMISSIONS.map((p) => {
    const cells = ROLES.slice()
      .reverse()
      .map((r) => (can(r, p) ? `<td class="yes">${tick}<span class="sr">Yes</span></td>` : `<td class="no">${dash}<span class="sr">No</span></td>`))
      .join('');
    return `<tr><td>${esc(PERMISSION_TEXT[p])}</td>${cells}</tr>`;
  }).join('');
  return `<div class="scroll"><table class="matrix"><caption class="sr">What each role can do</caption><thead><tr><th scope="col">Can…</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function alertsPage(o: PageBase & { recipients: { sales: string[]; stakeholders: string[]; fromDashboard: boolean }; canTest: boolean; domains: string[]; flash?: Flash; draft?: { sales: string; stakeholders: string } }): string {
  const v = o.viewer;
  const sales = o.draft?.sales ?? o.recipients.sales.join('\n');
  const stakeholders = o.draft?.stakeholders ?? o.recipients.stakeholders.join('\n');
  const same = !o.draft && o.recipients.sales.length === o.recipients.stakeholders.length && o.recipients.sales.every((a, i) => a === o.recipients.stakeholders[i]);
  const test = (list: 'sales' | 'stakeholders', label: string): string =>
    o.canTest ? `<form method="post" action="/alerts/test" class="inline">${csrfField(v)}<input type="hidden" name="list" value="${list}"><button class="btn ghost sm" type="submit">${esc(label)}</button></form>` : '';
  const body = `<h1 class="pt">Alerts</h1><p class="sub ptsub">Choose who receives the quote assistant's emails. Each alert goes only to the addresses on its list, and never to a customer.</p>${flashHtml(o.flash)}
<section class="panel mb" aria-labelledby="h-al"><h2 id="h-al">Who gets which alert</h2>
<p class="sub">${o.recipients.fromDashboard ? 'These lists were set here by an owner.' : 'These addresses were set up when your assistant was installed. Save here to choose your own.'}${same ? ' Right now everything goes to the same address.' : ''}</p>
<form class="form" method="post" action="/alerts">${csrfField(v)}
<div><label for="al-s">Sales</label><textarea id="al-s" name="sales" rows="3" maxlength="1200" placeholder="sales@yourcompany.com">${esc(sales)}</textarea><p class="sub p8">One address per line. Gets "Draft Quotation Created", "Additional Information Required", "Customer not found", failures and the daily summary.</p></div>
<div><label for="al-t">Stakeholders</label><textarea id="al-t" name="stakeholders" rows="3" maxlength="1200" placeholder="manager@yourcompany.com">${esc(stakeholders)}</textarea><p class="sub p8">One address per line. Gets "New/Unmatched Products Identified" when items could not be priced.</p></div>
${o.domains.length ? `<p class="sub p8">Only addresses on ${esc(o.domains.join(', '))} are accepted.</p>` : ''}
<div class="actions"><button class="btn" type="submit">Save</button></div></form></section>
<section class="panel mb" aria-labelledby="h-at"><h2 id="h-at">Check that it works</h2><p class="sub">Sends one short test email to everyone on the saved list. Nothing goes to a customer.</p>
<div class="actions">${test('sales', 'Send a test to Sales')}${test('stakeholders', 'Send a test to stakeholders')}${o.canTest ? '' : '<span class="sub">Sending a test needs the quote service to be running.</span>'}</div></section>
${o.recipients.fromDashboard ? `<section class="panel mb" aria-labelledby="h-ar"><h2 id="h-ar">Go back to the addresses from setup</h2><p class="sub">Stops using the lists saved here and goes back to the addresses that were set up when the assistant was installed.</p><form method="post" action="/alerts/reset">${csrfField(v)}<div class="actions"><button class="btn ghost" type="submit">Go back to the setup addresses</button></div></form></section>` : ''}`;
  return wrap(o, 'alerts', 'Alerts', body);
}

export function teamPage(o: PageBase & { people: User[]; flash?: Flash; draft?: { name?: string; email?: string; role?: string } }): string {
  const v = o.viewer;
  const manage = can(v.role, 'team.manage');
  const rows = o.people
    .map((p) => {
      const mine = p.id === v.id;
      const open = manage && !mine && canManage(v.role, p.role);
      return `<tr class="person-row"><td><div class="cust"><span class="av" aria-hidden="true">${esc(initials(p.name))}</span><div><span class="nm">${esc(p.name)}${mine ? '<span class="you">(you)</span>' : ''}</span><div class="em">${esc(p.email)}</div></div></div></td><td>${roleChip(p.role)}</td><td>${userStatus(p, o.now, o.tz)}</td><td class="num nowrap">${p.lastLoginAt ? esc(relTime(p.lastLoginAt, o.now, o.tz)) : '<span class="sub">Never</span>'}</td><td class="r">${open ? `<a href="/team/${p.id}">Manage</a>` : mine ? '<a href="/account">Your account</a>' : '<span class="sub">—</span>'}</td></tr>`;
    })
    .join('');
  const choices = assignableRoles(v.role);
  const add = manage && choices.length
    ? `<section class="panel mb" aria-labelledby="h-add"><h2 id="h-add">Add a person</h2><p class="sub">They get a one-time password to start with, and choose their own at first sign-in.</p>
<form class="form cols" method="post" action="/team/new">${csrfField(v)}
<div><label for="n">Name</label><input id="n" name="name" type="text" required maxlength="80" autocomplete="off" value="${esc(o.draft?.name ?? '')}"></div>
<div><label for="e">Email (their sign-in name)</label><input id="e" name="email" type="email" required maxlength="254" autocomplete="off" value="${esc(o.draft?.email ?? '')}"></div>
<div><label for="r">Role</label><select id="r" name="role">${choices.map((r) => `<option value="${r}"${(o.draft?.role ?? 'staff') === r ? ' selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}</select></div>
<div class="actions"><button class="btn" type="submit">Add and show the first password</button></div></form></section>`
    : '';
  const cards = ROLES.slice()
    .reverse()
    .map((r) => `<div class="panel">${roleChip(r)}<p>${esc(ROLE_INFO[r].blurb)}</p></div>`)
    .join('');
  const body = `<h1 class="pt">Team</h1><p class="sub ptsub">${o.people.filter((p) => p.active).length} ${o.people.filter((p) => p.active).length === 1 ? 'person has' : 'people have'} a login. Each person signs in with their own email, so notes and changes always show who did them.</p>
${flashHtml(o.flash)}
<section class="panel mb"><div class="scroll"><table class="ledger"><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last signed in</th><th class="r"><span class="sr">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div></section>
${add}
<h2 class="pt">What each role can do</h2><p class="sub ptsub">A person sees only the pages their role allows. Higher roles can add and manage the roles below them.</p>
<div class="rolecards mb">${cards}</div>
<section class="panel">${rolesTable()}</section>`;
  return wrap(o, 'team', 'Team', body);
}

export function personPage(o: PageBase & { person: User; tempPassword?: string; signInUrl: string; flash?: Flash }): string {
  const v = o.viewer;
  const p = o.person;
  const choices = assignableRoles(v.role);
  const locked = Boolean(p.lockedUntil && p.lockedUntil > o.now.toISOString());
  const facts: Array<[string, string]> = [
    ['Email', esc(p.email)],
    ['Role', roleChip(p.role)],
    ['Status', userStatus(p, o.now, o.tz)],
    ['Last signed in', p.lastLoginAt ? esc(fmtDateTime(p.lastLoginAt, o.tz)) : 'Never'],
    ['Added', esc(fmtDateTime(p.createdAt, o.tz))],
  ];
  const secret = o.tempPassword
    ? `<section class="secret" aria-labelledby="h-secret"><h2 id="h-secret">One-time password for ${esc(p.name)}</h2><p><code>${esc(o.tempPassword)}</code></p><p>Give it to them in person, by phone, or in a private message. <b>It is shown only now</b> and cannot be looked up later (if it is lost, reset it again). They sign in at <b>${esc(o.signInUrl)}</b> with <b>${esc(p.email)}</b> and will be asked to choose their own password.</p></section>`
    : '';
  const roleForm = choices.length
    ? `<form class="form" method="post" action="/team/${p.id}/role">${csrfField(v)}<label for="rl">Role</label><select id="rl" name="role">${choices.map((r) => `<option value="${r}"${r === p.role ? ' selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}</select><div class="actions"><button class="btn sm" type="submit">Save role</button></div></form>`
    : '';
  const body = `<p class="back"><a href="/team">← Team</a></p>
<div class="head mid"><h1 class="pt big">${esc(p.name)}</h1></div><p class="chipsrow">${roleChip(p.role)} ${userStatus(p, o.now, o.tz)}</p>
${flashHtml(o.flash)}${secret}
<div class="row r2"><section class="panel"><h2>Details</h2><dl class="facts">${facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val}</dd>`).join('')}</dl><p class="sub mt">${esc(ROLE_INFO[p.role].blurb)}</p></section>
<section class="panel"><h2>Change access</h2><p class="sub">Changes apply straight away; if they are signed in, the next page they open follows their new role.</p>${roleForm}
<div class="actions">
<form method="post" action="/team/${p.id}/reset">${csrfField(v)}<button class="btn ghost sm" type="submit">Reset password</button></form>
${locked ? `<form method="post" action="/team/${p.id}/unlock">${csrfField(v)}<button class="btn ghost sm" type="submit">Let them try again now</button></form>` : ''}
<form method="post" action="/team/${p.id}/active">${csrfField(v)}<input type="hidden" name="active" value="${p.active ? '0' : '1'}"><button class="btn ${p.active ? 'danger' : 'ghost'} sm" type="submit">${p.active ? 'Switch off this login' : 'Switch this login back on'}</button></form></div>
<p class="sub p8">Resetting a password signs them out everywhere and gives them a new one-time password. Switching a login off keeps their history; nothing is deleted.</p></section></div>`;
  return wrap(o, 'team', p.name, body);
}

// --- account -----------------------------------------------------------------------------------------------------------------------

export function accountPage(o: PageBase & { user: User; sessions: SessionInfo[]; currentSessionId: string; flash?: Flash }): string {
  const v = o.viewer;
  const sessions = o.sessions
    .map((s) => {
      const here = s.id === o.currentSessionId;
      return `<div class="sess"><div><b>${esc(describeDevice(s.userAgent))}</b>${here ? '<span class="you">this device</span>' : ''}<div class="sub">${s.ip ? `${esc(s.ip)} · ` : ''}Signed in ${esc(relTime(s.createdAt, o.now, o.tz))}</div></div><div class="sub num nowrap">Last active ${esc(relTime(s.lastSeenAt, o.now, o.tz))}</div></div>`;
    })
    .join('');
  const others = o.sessions.some((s) => s.id !== o.currentSessionId);
  const allowed = PERMISSIONS.filter((p) => can(v.role, p)).map((p) => `<li>${esc(PERMISSION_TEXT[p])}</li>`).join('');
  const body = `<h1 class="pt">Your account</h1><p class="sub ptsub">Signed in as <b>${esc(o.user.email)}</b> · ${roleChip(o.user.role)}</p>${flashHtml(o.flash)}
<div class="row r2"><section class="panel"><h2>Your name</h2><p class="sub">Shown next to notes and changes you make.</p><form class="form" method="post" action="/account/name">${csrfField(v)}<label for="nm">Name</label><input id="nm" name="name" type="text" required maxlength="80" value="${esc(o.user.name)}"><div class="actions"><button class="btn sm" type="submit">Save name</button></div></form></section>
<section class="panel"><h2>Change your password</h2><p class="sub">You will stay signed in here and be signed out everywhere else.</p><form class="form" method="post" action="/account/password">${csrfField(v)}
<label for="cur">Current password</label><input id="cur" name="current" type="password" required autocomplete="current-password">
<label for="np">New password</label><input id="np" name="password" type="password" required minlength="10" autocomplete="new-password"><p class="hint">At least 10 characters.</p>
<label for="np2">New password again</label><input id="np2" name="confirm" type="password" required minlength="10" autocomplete="new-password">
<div class="actions"><button class="btn sm" type="submit">Change password</button></div></form></section></div>
<div class="row r2"><section class="panel"><h2>Where you are signed in</h2><p class="sub">If you see a device you do not recognise, change your password.</p>${sessions || '<p class="sub">Nothing to show.</p>'}${others ? `<form method="post" action="/account/signout-others" class="mt">${csrfField(v)}<button class="btn ghost sm" type="submit">Sign out my other devices</button></form>` : ''}</section>
<section class="panel"><h2>What your role allows</h2><p class="sub">${esc(ROLE_INFO[o.user.role].blurb)}</p><ul class="plain">${allowed}</ul></section></div>`;
  return wrap(o, 'account', 'Your account', body);
}

// --- activity ----------------------------------------------------------------------------------------------------------------------

export const ACTIVITY_FILTERS: Array<{ key: string; label: string; kinds?: string[] }> = [
  { key: 'all', label: 'Everything' },
  { key: 'signins', label: 'Sign-ins', kinds: ['login', 'login_failed', 'login_locked', 'logout'] },
  { key: 'team', label: 'Team changes', kinds: ['owner_created', 'user_created', 'role_changed', 'user_deactivated', 'user_reactivated', 'password_reset', 'password_changed', 'user_unlocked', 'sessions_revoked', 'name_changed'] },
  { key: 'work', label: 'Work on enquiries', kinds: ['note_added', 'marked_handled', 'reopened', 'customer_added', 'customer_add_failed'] },
  { key: 'downloads', label: 'Downloads', kinds: ['export'] },
];

export function describeSecurityEvent(e: SecurityEvent): string {
  const who = e.actor || 'Someone';
  const t = e.target ?? '';
  switch (e.event) {
    case 'login': return `${who} signed in`;
    case 'login_failed': return `A wrong password was entered for ${t || 'an unknown email'}`;
    case 'login_locked': return `${t} was paused for 15 minutes after repeated wrong passwords`;
    case 'logout': return `${who} signed out`;
    case 'owner_created': return `The first owner login was created for ${t}`;
    case 'user_created': return `${who} added ${t} as ${e.detail ?? 'a team member'}`;
    case 'role_changed': return `${who} changed ${t}: ${e.detail ?? 'role'}`;
    case 'user_deactivated': return `${who} switched off the login for ${t}`;
    case 'user_reactivated': return `${who} switched the login for ${t} back on`;
    case 'password_reset': return `${who} reset the password for ${t}`;
    case 'password_changed': return `${who} changed their own password`;
    case 'user_unlocked': return `${who} let ${t} try signing in again`;
    case 'sessions_revoked': return `${who} signed out their other devices`;
    case 'name_changed': return `${who} changed their name`;
    case 'export': return `${who} downloaded the enquiry list${e.detail ? ` (${e.detail})` : ''}`;
    case 'note_added': return `${who} added a note on ${t}`;
    case 'marked_handled': return `${who} marked ${t} as handled`;
    case 'reopened': return `${who} reopened ${t}`;
    case 'customer_added': return `${who} added a new customer to Zoho Books from ${t}${e.detail ? `: ${e.detail}` : ''}`;
    case 'customer_add_failed': return `${who} tried to add a customer from ${t}, but Zoho Books refused${e.detail ? `: ${e.detail}` : ''}`;
    case 'access_denied': return `${who} tried to open ${t}, which their role does not allow`;
    default: return `${who}: ${e.event}${t ? ` (${t})` : ''}`;
  }
}

export function activityPage(o: PageBase & { events: SecurityEvent[]; total: number; filter: string; page: number; pages: number }): string {
  const tabs = ACTIVITY_FILTERS.map((f) => `<a href="/activity?filter=${f.key}"${f.key === o.filter ? ' class="on"' : ''}>${esc(f.label)}</a>`).join('');
  const rows = o.events
    .map((e) => `<tr><td class="num nowrap" title="${esc(fmtDateTime(e.at, o.tz))}">${esc(relTime(e.at, o.now, o.tz))}</td><td>${esc(describeSecurityEvent(e))}</td><td class="sub">${esc(e.ip ?? '')}</td></tr>`)
    .join('');
  const pager = o.pages > 1 ? `<div class="pager">${o.page > 1 ? `<a href="/activity?filter=${o.filter}&amp;page=${o.page - 1}">← Newer</a>` : ''}<span>Page ${o.page} of ${o.pages}</span>${o.page < o.pages ? `<a href="/activity?filter=${o.filter}&amp;page=${o.page + 1}">Older →</a>` : ''}</div>` : '';
  const body = `<h1 class="pt">Activity</h1><p class="sub ptsub">Who signed in, who changed access, and who worked on or downloaded enquiries. Kept for the same period as your other records.</p>
<div class="tabs">${tabs}</div><section class="panel">${rows ? `<div class="scroll"><table class="ledger"><thead><tr><th>When</th><th>What happened</th><th>From</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<div class="empty">Nothing recorded here yet.</div>'}</section>`;
  return wrap(o, 'activity', 'Activity', body);
}
