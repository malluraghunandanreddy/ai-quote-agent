import type { Config } from '../config';
import type { Enquiry, Repository } from '../db/repository';
import { attentionReason, computeHealth, isAttention, isDraft, timeSavedMinutes, usageCost, type HealthStatus } from '../ops/monitor';
import type { EnquiryStatus } from '../types';
import type { DayBucket } from './charts';
import { csvCell, fmtDateTime, fmtMoneyShort, fmtUsd, greeting, localParts, relTime, startOfLocalDay } from './format';

export type RangeKey = 'today' | '7d' | '30d';

export const RANGES: Array<{ key: RangeKey; label: string; phrase: string }> = [
  { key: 'today', label: 'Today', phrase: 'today' },
  { key: '7d', label: 'Last 7 days', phrase: 'in the last 7 days' },
  { key: '30d', label: 'Last 30 days', phrase: 'in the last 30 days' },
];

const DAY = 24 * 60 * 60_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const parseRange = (v: string | null | undefined): RangeKey => (v === 'today' || v === '30d' ? v : '7d');

export interface Stage {
  key: string;
  label: string;
  count: number;
  /** 0-100, relative to enquiries received. */
  pct: number;
  /** What fell out before this stage, in words. */
  drop: string;
  href: string;
}

export interface Outcome {
  key: string;
  label: string;
  kind: 'good' | 'warn' | 'crit' | 'neutral';
  count: number;
}

export interface DeskItem {
  id: number;
  who: string;
  sender: string;
  subject: string;
  status: EnquiryStatus;
  why: string;
  when: string;
}

export interface ServiceRow {
  name: string;
  kind: 'ok' | 'warn' | 'bad';
  state: string;
  detail: string;
}

export interface OverviewModel {
  greeting: string;
  dateLine: string;
  clientName: string;
  range: RangeKey;
  rangeLabel: string;
  lede: string;
  hero: { minutes: number; hours: number; mins: number; equiv: string };
  chips: Array<{ value: string; label: string }>;
  kpis: { received: number; drafts: number; toPrice: number; openAttention: number; valueInDrafts: number; currency: string };
  deltas: { received: string | null; drafts: string | null };
  sparks: { received: number[]; drafts: number[] };
  days: DayBucket[];
  stages: Stage[];
  outcomes: Outcome[];
  desk: DeskItem[];
  deskResolved: number;
  /** Items a team member marked handled (so they no longer count as waiting). */
  deskHandled: number;
  topCustomers: Array<{ name: string; total: number; drafts: number; display: string }>;
  heat: number[][];
  heatTotal: number;
  recent: Enquiry[];
  health: HealthStatus;
  services: ServiceRow[];
  llm: { calls: number; usd: number; perDraftUsd: number };
  demo: boolean;
  live: { kind: 'ok' | 'warn' | 'bad'; text: string };
  banner?: { kind: 'warn' | 'bad'; html: string };
}

function rangeStart(key: RangeKey, now: Date, tz: string): Date {
  return key === 'today' ? startOfLocalDay(now, tz) : new Date(now.getTime() - (key === '7d' ? 7 : 30) * DAY);
}

function delta(now: number, before: number, label: string): string | null {
  if (now === 0 && before === 0) return null;
  const d = now - before;
  return d === 0 ? `same as ${label}` : `${d > 0 ? '+' : '−'}${Math.abs(d)} vs ${label}`;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function services(repo: Repository, config: Config, health: HealthStatus, now: Date): ServiceRow[] {
  const tz = config.timezone;
  const lastBackupAt = repo.getMeta('last_backup_at') || undefined;
  const backupOk = repo.getMeta('last_backup_ok') !== '0';
  const backupFresh = lastBackupAt ? now.getTime() - new Date(lastBackupAt).getTime() < 36 * 60 * 60_000 : false;
  return [
    config.imap
      ? { name: 'Mailbox', kind: health.ok ? 'ok' : 'bad', state: health.ok ? 'Connected' : 'Problem', detail: health.ok ? `${config.imap.user} · checked ${relTime(health.lastPollOkAt, now, tz)}` : (health.reason ?? 'Not responding') }
      : { name: 'Mailbox', kind: 'warn', state: 'Not set up', detail: 'The mailbox connection has not been configured yet.' },
    config.zoho
      ? { name: 'Zoho Books', kind: 'ok', state: 'Connected', detail: `Organization ${config.zoho.organizationId} · books.zoho.${config.zoho.dc}` }
      : { name: 'Zoho Books', kind: 'warn', state: 'Not set up', detail: 'Zoho credentials have not been added yet.' },
    config.llm.enabled
      ? { name: 'Claude (reads the emails)', kind: 'ok', state: 'On', detail: `${config.llm.model} · used only to read email text and odd column headings` }
      : { name: 'Claude (reads the emails)', kind: 'warn', state: 'Off', detail: `Using simple rules only (${config.llm.disabledReason ?? 'not configured'}).` },
    config.smtp
      ? { name: 'Alert emails', kind: 'ok', state: 'On', detail: `Sent to ${config.notify.internal}` }
      : { name: 'Alert emails', kind: 'warn', state: 'Not set up', detail: 'Alerts are only written to the log until outgoing mail is configured.' },
    { name: 'Daily backup', kind: !lastBackupAt ? 'warn' : backupOk && backupFresh ? 'ok' : 'bad', state: !lastBackupAt ? 'No backup yet' : backupOk && backupFresh ? 'Up to date' : 'Needs attention', detail: lastBackupAt ? `Last backup ${relTime(lastBackupAt, now, tz)} · kept ${config.backup.keep} days` : 'The first backup is taken overnight.' },
  ];
}

function deskReason(repo: Repository, e: Enquiry): string {
  if (e.status === 'NEEDS_INFO') {
    const detail = repo.auditTrail(e.id).find((a) => a.event === 'NEEDS_INFO')?.detail;
    if (detail) return `${detail.split(' | ')[0]} Ask the sender for a readable Excel.`;
  }
  return attentionReason(e);
}

/** What every page shows regardless of its content: the live indicator, a problem banner, the demo ribbon. */
export function chrome(repo: Repository, config: Config, now: Date = new Date()): {
  health: HealthStatus;
  services: ServiceRow[];
  live: { kind: 'ok' | 'warn' | 'bad'; text: string };
  banner?: { kind: 'warn' | 'bad'; html: string };
  demo: boolean;
} {
  const tz = config.timezone;
  const health = computeHealth(repo, config, now);
  const svc = services(repo, config, health, now);
  const live: { kind: 'ok' | 'warn' | 'bad'; text: string } = health.ok
    ? { kind: 'ok', text: health.lastPollOkAt ? `Live · checked ${relTime(health.lastPollOkAt, now, tz)}` : 'Live · starting up' }
    : { kind: 'bad', text: 'Not processing emails' };
  const backupBad = svc.find((s) => s.name === 'Daily backup' && s.kind === 'bad');
  const banner: { kind: 'warn' | 'bad'; html: string } | undefined = !health.ok
    ? { kind: 'bad', html: `<strong>Emails are not being processed.</strong> ${health.reason ?? ''} <a href="/status">See what to check</a>` }
    : backupBad
      ? { kind: 'warn', html: '<strong>The last backup did not complete.</strong> Your data is safe, but please tell support. <a href="/status">Details</a>' }
      : undefined;
  return { health, services: svc, live, ...(banner ? { banner } : {}), demo: repo.getMeta('demo') === '1' };
}

export function overview(repo: Repository, config: Config, range: RangeKey, now: Date = new Date(), handled: ReadonlySet<number> = new Set()): OverviewModel {
  const tz = config.timezone;
  const all = repo.enquiriesSince(new Date(now.getTime() - 90 * DAY).toISOString());
  const start = rangeStart(range, now, tz);
  const span = range === 'today' ? DAY : range === '7d' ? 7 * DAY : 30 * DAY;
  const inRange = all.filter((e) => e.createdAt >= start.toISOString());
  const before = all.filter((e) => e.createdAt >= new Date(start.getTime() - span).toISOString() && e.createdAt < start.toISOString());
  const drafts = inRange.filter((e) => isDraft(e.status));
  const toPrice = drafts.filter((e) => e.status === 'QUOTE_CREATED_WITH_EXCEPTIONS');
  const rangeInfo = RANGES.find((r) => r.key === range) ?? RANGES[1]!;
  const prevLabel = range === 'today' ? 'yesterday' : `the ${range === '7d' ? '7' : '30'} days before`;

  // --- needs a person (self-cleaning: a later draft from the same sender resolves it) -------------------------------
  const recent30 = all.filter((e) => e.createdAt >= new Date(now.getTime() - 30 * DAY).toISOString());
  const draftSenders = new Map<string, number>();
  for (const e of all) if (isDraft(e.status)) draftSenders.set(e.senderEmail, Math.max(draftSenders.get(e.senderEmail) ?? 0, e.id));
  const open: Enquiry[] = [];
  let resolved = 0;
  let handledCount = 0;
  for (const e of recent30) {
    if (!isAttention(e.status)) continue;
    if (handled.has(e.id)) handledCount++;
    else if ((draftSenders.get(e.senderEmail) ?? 0) > e.id) resolved++;
    else open.push(e);
  }
  const desk: DeskItem[] = open.slice(0, 8).map((e) => ({
    id: e.id,
    who: e.companyInEmail || e.senderEmail,
    sender: e.senderEmail,
    subject: e.subject,
    status: e.status,
    why: deskReason(repo, e),
    when: relTime(e.createdAt, now, tz),
  }));

  // --- daily buckets, last 14 days ------------------------------------------------------------------------------------
  const byDay = new Map<string, { drafts: number; attention: number; received: number }>();
  for (const e of all) {
    const ymd = localParts(new Date(e.createdAt), tz).ymd;
    const b = byDay.get(ymd) ?? { drafts: 0, attention: 0, received: 0 };
    b.received++;
    if (isDraft(e.status)) b.drafts++;
    else if (isAttention(e.status)) b.attention++;
    byDay.set(ymd, b);
  }
  const dayList = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now.getTime() - (13 - i) * DAY);
    const p = localParts(d, tz);
    const b = byDay.get(p.ymd) ?? { drafts: 0, attention: 0, received: 0 };
    return { p, b, month: MONTHS[Number(p.ymd.slice(5, 7)) - 1] ?? '' };
  });
  const days: DayBucket[] = dayList.map(({ p, b, month }, i) => ({
    label: String(Number(p.ymd.slice(8))),
    ...(i === 0 || p.ymd.endsWith('-01') ? { month } : {}),
    tip: `${WEEKDAYS[p.weekday]} ${Number(p.ymd.slice(8))} ${month}\n${b.drafts} draft ${b.drafts === 1 ? 'quote' : 'quotes'}${b.attention ? `\n${b.attention} needed a person` : ''}`,
    drafts: b.drafts,
    attention: b.attention,
  }));
  const last7 = dayList.slice(-7).map((d) => d.b);

  // --- pipeline ---------------------------------------------------------------------------------------------------------
  const N = inRange.length;
  const count = (f: (e: Enquiry) => boolean): number => inRange.filter(f).length;
  const needInfo = count((e) => e.status === 'NEEDS_INFO');
  const halted = count((e) => e.status === 'HALTED_CUSTOMER_NOT_FOUND' || e.status === 'HALTED_CUSTOMER_AMBIGUOUS');
  const failed = count((e) => e.status === 'FAILED' || e.status === 'PROCESSING');
  const readable = N - needInfo, matched = readable - halted, priced = N === 0 ? 0 : drafts.length - toPrice.length;
  const pct = (n: number): number => (N === 0 ? 0 : Math.round((n / N) * 100));
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const stages: Stage[] = [
    { key: 'received', label: 'Emails received', count: N, pct: N ? 100 : 0, drop: 'Every enquiry the mailbox picked up.', href: '/enquiries' },
    { key: 'excel', label: 'Excel read', count: readable, pct: pct(readable), drop: needInfo ? `<b>${plural(needInfo, 'email', 'emails')}</b> had no readable Excel.` : 'Every email had a readable Excel.', href: '/enquiries?filter=attention' },
    { key: 'customer', label: 'Customer matched', count: matched, pct: pct(matched), drop: halted ? `<b>${plural(halted, 'sender', 'senders')}</b> not found or unclear in Zoho.` : 'Every sender was a known customer.', href: '/enquiries?filter=attention' },
    { key: 'draft', label: 'Draft created', count: drafts.length, pct: pct(drafts.length), drop: failed ? `<b>${plural(failed, 'enquiry', 'enquiries')}</b> failed or still processing.` : 'Nothing got stuck on the way.', href: '/enquiries?filter=drafts' },
    { key: 'priced', label: 'Fully priced', count: priced, pct: pct(priced), drop: toPrice.length ? `<b>${plural(toPrice.length, 'draft', 'drafts')}</b> with items to price.` : 'Every line found its price.', href: '/enquiries?filter=toprice' },
  ];

  const outcomes: Outcome[] = [
    { key: 'ready', label: 'Draft ready', kind: 'good', count: priced },
    { key: 'toprice', label: 'Draft, items to price', kind: 'warn', count: toPrice.length },
    { key: 'person', label: 'Customer problem or failure', kind: 'crit', count: halted + failed },
    { key: 'info', label: 'Needs information', kind: 'neutral', count: needInfo },
  ];

  // --- value, customers, time saved -------------------------------------------------------------------------------------
  const currencies = new Map<string, number>();
  for (const e of drafts) currencies.set(e.currencyCode ?? 'INR', (currencies.get(e.currencyCode ?? 'INR') ?? 0) + 1);
  const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'INR';
  const valueInDrafts = sum(drafts.filter((e) => (e.currencyCode ?? 'INR') === currency).map((e) => e.totalAmount ?? 0));
  const perCustomer = new Map<string, { total: number; drafts: number }>();
  for (const e of drafts) {
    const name = e.customerName || e.companyInEmail || e.senderEmail;
    const c = perCustomer.get(name) ?? { total: 0, drafts: 0 };
    c.total += (e.currencyCode ?? 'INR') === currency ? (e.totalAmount ?? 0) : 0;
    c.drafts++;
    perCustomer.set(name, c);
  }
  const topCustomers = [...perCustomer.entries()]
    .map(([name, c]) => ({ name, total: c.total, drafts: c.drafts, display: fmtMoneyShort(c.total, currency) }))
    .sort((a, b) => b.total - a.total || b.drafts - a.drafts)
    .slice(0, 6);

  const minutes = timeSavedMinutes(drafts, config.roi);
  const workingDays = minutes / 480;
  const usage = usageCost(repo.llmUsageSince(localParts(start, tz).ymd), config.llm);
  const perDraftUsd = drafts.length ? usage.estimatedUsd / drafts.length : 0;

  // --- when enquiries arrive ----------------------------------------------------------------------------------------------
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 12 }, () => 0));
  for (const e of all) {
    const p = localParts(new Date(e.createdAt), tz);
    heat[p.weekday]![Math.floor(p.hour / 2)]!++;
  }

  const { health, services: svc, live, banner } = chrome(repo, config, now);

  const people = open.length;
  const lede =
    inRange.length === 0
      ? `No enquiries have come in ${rangeInfo.phrase}. The assistant is watching the mailbox.`
      : `${plural(N, 'enquiry', 'enquiries')} arrived ${rangeInfo.phrase}. ${drafts.length > 0 ? `${drafts.length} draft ${drafts.length === 1 ? 'quote is' : 'quotes are'} waiting in Zoho Books${toPrice.length ? `, ${toPrice.length} with items that still need a price` : ''}.` : 'No draft quotes were created.'} ${people > 0 ? `${people} ${people === 1 ? 'needs' : 'need'} a person.` : 'Nothing needs your attention.'}`;

  return {
    greeting: greeting(now, tz),
    dateLine: new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now),
    clientName: config.dashboard.clientName,
    range,
    rangeLabel: rangeInfo.label,
    lede,
    hero: {
      minutes,
      hours: Math.floor(minutes / 60),
      mins: Math.round(minutes % 60),
      equiv: minutes >= 480 ? `About ${workingDays >= 10 ? Math.round(workingDays) : workingDays.toFixed(1).replace(/\.0$/, '')} working days of typing, matching and checking, done before anyone opened the inbox.` : drafts.length > 0 ? `${drafts.length} draft ${drafts.length === 1 ? 'quote' : 'quotes'} that nobody had to type.` : 'Time saved appears here as soon as the first draft is created.',
    },
    chips: [
      ...(config.roi.staffCostPerHour && minutes > 0
        ? [{ value: fmtMoneyShort((minutes / 60) * config.roi.staffCostPerHour, currency), label: `of staff time saved, at ${fmtMoneyShort(config.roi.staffCostPerHour, currency)} an hour` }]
        : []),
      ...(drafts.length ? [{ value: fmtMoneyShort(valueInDrafts, currency), label: 'waiting in drafts' }] : []),
      ...(config.dashboard.showAiCost ? [{ value: fmtUsd(usage.estimatedUsd), label: perDraftUsd ? `AI cost · ${fmtUsd(perDraftUsd)} per draft` : 'AI cost' }] : []),
    ],
    kpis: { received: N, drafts: drafts.length, toPrice: toPrice.length, openAttention: open.length, valueInDrafts, currency },
    deltas: { received: delta(N, before.length, prevLabel), drafts: delta(drafts.length, before.filter((e) => isDraft(e.status)).length, prevLabel) },
    sparks: { received: last7.map((b) => b.received), drafts: last7.map((b) => b.drafts) },
    days,
    stages,
    outcomes,
    desk,
    deskResolved: resolved,
    deskHandled: handledCount,
    topCustomers,
    heat,
    heatTotal: sum(heat.flat()),
    recent: inRange.length ? inRange.slice(0, 10) : all.slice(0, 10),
    health,
    services: svc,
    llm: { calls: usage.calls, usd: usage.estimatedUsd, perDraftUsd },
    demo: repo.getMeta('demo') === '1',
    live,
    ...(banner ? { banner } : {}),
  };
}

// --- enquiries list and detail -----------------------------------------------------------------------------------------------

export const FILTERS: Array<{ key: string; label: string; statuses?: EnquiryStatus[]; flagged?: boolean }> = [
  { key: 'all', label: 'All' },
  { key: 'drafts', label: 'Drafts', statuses: ['QUOTE_CREATED', 'QUOTE_CREATED_WITH_EXCEPTIONS'] },
  { key: 'toprice', label: 'Items to price', statuses: ['QUOTE_CREATED_WITH_EXCEPTIONS'] },
  { key: 'flagged', label: 'Check before sending', flagged: true },
  { key: 'attention', label: 'Needs a person', statuses: ['NEEDS_INFO', 'HALTED_CUSTOMER_NOT_FOUND', 'HALTED_CUSTOMER_AMBIGUOUS', 'FAILED'] },
];

export const PAGE_SIZE = 20;

export function listing(repo: Repository, filterKey: string, page: number): { filter: string; rows: Enquiry[]; total: number; page: number; pages: number } {
  const f = FILTERS.find((x) => x.key === filterKey) ?? FILTERS[0]!;
  const p = Math.max(1, Math.floor(page) || 1);
  const { rows, total } = repo.listEnquiries({ ...(f.statuses ? { statuses: f.statuses } : {}), ...(f.flagged ? { flaggedOnly: true } : {}), limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE });
  return { filter: f.key, rows, total, page: p, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

const NOTICE_NAMES: Record<string, string> = {
  A_ADDITIONAL_INFO: 'More information needed',
  B_UNMATCHED_PRODUCTS: 'Items need pricing',
  C_DRAFT_CREATED: 'Draft created',
  CUSTOMER_NOT_FOUND: 'Customer not found',
  PROCESSING_FAILED: 'Processing failed',
};

const FINAL: Record<string, string> = {
  QUOTE_CREATED: 'Finished: draft ready',
  QUOTE_CREATED_WITH_EXCEPTIONS: 'Finished: draft ready, some items need pricing',
  NEEDS_INFO: 'Stopped: more information is needed',
  HALTED_CUSTOMER_NOT_FOUND: 'Stopped: customer not found in Zoho Books',
  HALTED_CUSTOMER_AMBIGUOUS: 'Stopped: more than one customer fits',
  FAILED: 'Something went wrong',
};

/** Turn a raw audit event into a sentence a client can read. */
export function describeEvent(event: string, detail: string | null): { what: string; more: string } {
  const d = detail ?? '';
  if (event === 'CLAIMED') return { what: 'Email received', more: d && d !== '(no attachment)' ? `Attachment: ${d}` : 'No attachment' };
  if (event === 'RETRY') return { what: 'Tried again', more: d };
  if (event === 'EMAIL_METADATA') return { what: 'Read the email text', more: d.startsWith('llm') ? 'Understood with Claude' : 'Read with simple rules' + (d.includes('flags=') ? ' · contained text addressed to an AI, which was ignored' : '') };
  if (event === 'EXCEL_PARSED') return { what: 'Read the Excel', more: d.replace('columns by rules', 'columns found by the standard rules').replace('columns by llm', 'columns placed with Claude, then checked') };
  if (event === 'CUSTOMER_RESOLVED') {
    const [tier = '', , ...name] = d.split(':');
    return { what: 'Matched the customer', more: `${name.join(':')} · by ${tier === 'email' ? 'sender email' : tier === 'domain' ? 'email domain' : 'company name'}` };
  }
  if (event === 'ESTIMATE_RECORDED') return { what: 'Draft created in Zoho Books', more: d.replace(/\s*\(.*\)$/, '') };
  if (event.startsWith('NOTIFIED_')) return { what: 'Alert emailed to your team', more: NOTICE_NAMES[event.slice(9)] ?? event.slice(9) };
  if (event === 'DUPLICATE_ENQUIRY_IGNORED') return { what: 'A repeat of this enquiry was ignored', more: d };
  if (FINAL[event]) return { what: FINAL[event]!, more: event === 'FAILED' ? d : '' };
  return { what: event.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), more: d };
}


// --- CSV export ----------------------------------------------------------------------------------------------------------------

export const EXPORT_LIMIT = 5000;

export function exportCsv(repo: Repository, filterKey: string, tz: string): { filename: string; body: string; rows: number; filter: string } {
  const f = FILTERS.find((x) => x.key === filterKey) ?? FILTERS[0]!;
  const { rows } = repo.listEnquiries({ ...(f.statuses ? { statuses: f.statuses } : {}), ...(f.flagged ? { flaggedOnly: true } : {}), limit: EXPORT_LIMIT, offset: 0 });
  const head = ['Received', 'Sender', 'Subject', 'Customer', 'Status', 'Quote number', 'Total', 'Currency', 'Lines', 'Priced', 'To price', 'Checks'];
  const lines = rows.map((e) =>
    [fmtDateTime(e.createdAt, tz), e.senderEmail, e.subject, e.customerName ?? e.companyInEmail ?? '', e.status, e.estimateNumber ?? '', e.totalAmount ?? '', e.currencyCode ?? '', e.lineCount ?? '', e.matchedCount ?? '', e.unmatchedCount ?? '', e.reviewFlags.join(' ')]
      .map(csvCell)
      .join(','),
  );
  const day = localParts(new Date(), tz).ymd;
  return { filename: `enquiries-${f.key}-${day}.csv`, body: `\ufeff${[head.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, rows: rows.length, filter: f.key };
}
