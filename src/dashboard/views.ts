import { can, roleLabel, type Permission, type Role } from '../auth/rbac';
import type { EnquiryStatus } from '../types';
import { statusIcon, type IconKind } from './charts';
import { esc, initials } from './format';
import crypto from 'node:crypto';
import { APP_JS } from './assets';
import { DEFAULT_BRAND, type Brand } from './brand';
import { CSS } from './theme';

export { CSS };

/** Script address with a fingerprint, like the stylesheet's, so a changed script is never served from a cached copy. */
const JS_HREF = `/assets/app.js?v=${crypto.createHash('sha1').update(APP_JS).digest('hex').slice(0, 8)}`;

const STATUS: Record<EnquiryStatus, { kind: IconKind; text: string }> = {
  QUOTE_CREATED: { kind: 'good', text: 'Draft ready' },
  QUOTE_CREATED_WITH_EXCEPTIONS: { kind: 'warn', text: 'Draft, items to price' },
  NEEDS_INFO: { kind: 'neutral', text: 'Needs information' },
  HALTED_CUSTOMER_NOT_FOUND: { kind: 'crit', text: 'Customer not found' },
  HALTED_CUSTOMER_AMBIGUOUS: { kind: 'warn', text: 'Customer unclear' },
  FAILED: { kind: 'crit', text: 'Failed' },
  PROCESSING: { kind: 'neutral', text: 'Processing' },
};

/** Status chip: shape + label + tint, never colour alone. */
export function statusChip(status: EnquiryStatus): string {
  const s = STATUS[status] ?? { kind: 'neutral' as const, text: status };
  return `<span class="st ${s.kind}">${statusIcon(s.kind, 13)}${esc(s.text)}</span>`;
}

export const REVIEW_FLAG_TEXT: Record<string, string> = {
  LARGE_QUANTITY: 'Large quantity',
  LARGE_TOTAL: 'Large total',
  FRACTIONAL_UNITS: 'Fractional count',
  DUPLICATE_ITEM: 'Repeated item',
};

export const flagChips = (flags: string[]): string =>
  flags.map((f) => `<span class="flag" title="Check this before sending">${esc(REVIEW_FLAG_TEXT[f] ?? f)}</span>`).join('');

/** The accessibility twin of a chart: the same numbers as a table. */
export function tableView(caption: string, headers: string[], rows: string[][]): string {
  return `<details class="tbl"><summary>View as table</summary><table><caption class="sr">${esc(caption)}</caption><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

export const MARK = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.2L12 5.3V13a.9.9 0 0 1-.9.9H4A.9.9 0 0 1 3.1 13V3.4A.9.9 0 0 1 4 2.5z" fill="#fff" fill-opacity=".95"/><path class="ck" d="M5.4 9l1.6 1.6L10.4 7" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The logo image, or the default mark when no logo is set. */
export const brandMark = (brand: Brand): string =>
  brand.logoUrl ? `<img class="logo" src="${esc(brand.logoUrl)}" alt="${brand.logoOnly ? esc(brand.name) : ''}">` : `<span class="mark">${MARK}</span>`;

/** The product name (and the client's name after it), unless the logo already says it. */
export const brandLabel = (brand: Brand, clientName = ''): string =>
  brand.logoUrl && brand.logoOnly ? '' : `<span>${esc(brand.name)}${clientName ? ` <small>· ${esc(clientName)}</small>` : ''}</span>`;

/** The signed-in person, as the pages need to know them. `csrf` goes into every form that changes something. */
export interface Viewer {
  id: number;
  name: string;
  email: string;
  role: Role;
  csrf: string;
}

export const csrfField = (v: Viewer): string => `<input type="hidden" name="_csrf" value="${esc(v.csrf)}">`;

export interface LayoutOptions {
  title: string;
  active: 'overview' | 'enquiries' | 'status' | 'team' | 'activity' | 'data' | 'account' | '';
  clientName: string;
  body: string;
  viewer?: Viewer;
  brand?: Brand;
  demo?: boolean;
  /** Live indicator in the top bar. */
  live?: { kind: 'ok' | 'warn' | 'bad'; text: string };
  /** A problem worth interrupting for (shown under the top bar). */
  banner?: { kind: 'warn' | 'bad'; html: string };
  /** Content placed between the top bar and the main column (the hero band). */
  hero?: string;
  refreshSeconds?: number;
}

/** [key, path, label, permission needed (none = everyone signed in)] */
const NAV: Array<[LayoutOptions['active'], string, string, Permission | null]> = [
  ['overview', '/', 'Overview', 'overview.view'],
  ['enquiries', '/enquiries', 'Enquiries', 'enquiries.view'],
  ['status', '/status', 'Status', 'status.view'],
  ['team', '/team', 'Team', 'team.view'],
  ['activity', '/activity', 'Activity', 'activity.view'],
  ['data', '/data', 'Your data', null],
];

export const roleChip = (role: Role): string => `<span class="role ${role}">${esc(roleLabel(role))}</span>`;

export function layout(o: LayoutOptions): string {
  const brand = o.brand ?? DEFAULT_BRAND;
  const v = o.viewer;
  const nav = v
    ? `<nav aria-label="Main">${NAV.filter(([, , , need]) => !need || can(v.role, need))
        .map(([key, href, label]) => `<a href="${href}"${key === o.active ? ' class="on" aria-current="page"' : ''}>${label}</a>`)
        .join('')}</nav>`
    : '';
  const right = v
    ? `<div class="right">${o.live ? `<span class="live" title="${esc(o.live.text)}"><span class="dot ${o.live.kind === 'ok' ? 'ok' : o.live.kind}"></span><span class="lt">${esc(o.live.text)}</span></span>` : ''}<a class="me${o.active === 'account' ? ' on' : ''}" href="/account" title="Your account"><span class="av sm" aria-hidden="true">${esc(initials(v.name))}</span><span class="who"><b>${esc(v.name)}</b>${roleChip(v.role)}</span></a><form method="post" action="/logout"><button class="quiet" type="submit">Sign out</button></form></div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light">
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ''}
<title>${esc(o.title)} · ${esc(brand.name)}</title><link rel="icon" href="${esc(brand.faviconHref)}"><link rel="stylesheet" href="${esc(brand.cssHref)}"><script src="${JS_HREF}" defer></script></head>
<body>${o.demo ? '<div class="ribbon">Demo data: a sample to show how the dashboard looks, not live enquiries</div>' : ''}
<header class="top"><div class="in"><a class="brand" href="/">${brandMark(brand)}${brandLabel(brand, o.clientName)}</a>${nav}${right}</div></header>
${o.banner ? `<div class="banner ${o.banner.kind === 'bad' ? 'bad' : ''}" role="status">${o.banner.html}</div>` : ''}
${o.hero ?? ''}
<main class="wrap">${o.body}</main>${brand.footer ? `<footer class="brandfoot">${esc(brand.footer)}</footer>` : ''}</body></html>`;
}
