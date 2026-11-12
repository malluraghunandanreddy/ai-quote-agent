import type { Config } from '../config';
import type { Enquiry } from '../db/repository';
import { attentionReason } from '../ops/monitor';
import { activityChart, heatmap, hbars, meter, sparkline, stackedBar, statusIcon, type IconKind } from './charts';
import { FILTERS, RANGES, describeEvent, type OverviewModel, type ServiceRow } from './data';
import { esc, fmtDateTime, fmtMoney, initials, relTime, safeUrl } from './format';
import type { EnquiryNote } from '../db/users';
import { can } from '../auth/rbac';
import type { CustomerDraft } from '../llm/customerExtractor';
import type { Brand } from './brand';
import { REVIEW_FLAG_TEXT, csrfField, flagChips, layout, roleChip, statusChip, tableView, type Viewer } from './views';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number): string => (h === 0 || h === 24 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const ICON: Record<string, IconKind> = { NEEDS_INFO: 'neutral', HALTED_CUSTOMER_NOT_FOUND: 'crit', HALTED_CUSTOMER_AMBIGUOUS: 'warn', FAILED: 'crit' };

// --- shared pieces ---------------------------------------------------------------------------------------------------------

function ledger(rows: Enquiry[], tz: string, now: Date): string {
  if (rows.length === 0) return `<div class="empty">Nothing here yet. Enquiries appear as soon as the mailbox picks them up.</div>`;
  const body = rows
    .map((e) => {
      const name = e.customerName || e.companyInEmail || e.senderEmail;
      const draft = e.status === 'QUOTE_CREATED' || e.status === 'QUOTE_CREATED_WITH_EXCEPTIONS';
      const url = safeUrl(e.quoteUrl);
      const lines = draft && e.lineCount ? `<div class="meter">${meter(e.matchedCount ?? 0, e.lineCount)}<span class="num">${e.matchedCount ?? 0} of ${e.lineCount} priced</span></div>` : '<span class="sub">—</span>';
      return `<tr>
<td><div class="cust"><span class="av" aria-hidden="true">${esc(initials(name))}</span><div><a class="nm" href="/enquiry/${e.id}">${esc(name)}</a><div class="em">${esc(e.senderEmail)}</div></div></div></td>
<td class="num" title="${esc(fmtDateTime(e.createdAt, tz))}">${esc(relTime(e.createdAt, now, tz))}</td>
<td>${lines}</td>
<td class="r num">${draft ? esc(fmtMoney(e.totalAmount, e.currencyCode)) : '<span class="sub">—</span>'}</td>
<td>${statusChip(e.status)}${flagChips(e.reviewFlags)}</td>
<td>${url && e.estimateNumber ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(e.estimateNumber)} ↗</a>` : `<a href="/enquiry/${e.id}">Details</a>`}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table class="ledger"><thead><tr><th>Customer</th><th>Received</th><th>Lines</th><th class="r">Total</th><th>Status</th><th>Quote</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function statStrip(m: OverviewModel): string {
  const stat = (label: string, value: number, note: string, spark?: string): string =>
    `<div class="stat"><div class="l">${esc(label)}</div><div class="v num"><span data-count="${value}">${value}</span></div><div class="n"><span>${note}</span>${spark ?? ''}</div></div>`;
  const up = (d: string | null): string => (d ? `<span class="${d.startsWith('+') ? 'up' : d.startsWith('−') ? 'down' : ''}">${esc(d)}</span>` : 'No change yet');
  return `<div class="strip rise d1">
${stat('Enquiries received', m.kpis.received, up(m.deltas.received), sparkline(m.sparks.received))}
${stat('Draft quotes created', m.kpis.drafts, up(m.deltas.drafts), sparkline(m.sparks.drafts))}
${stat('Drafts with items to price', m.kpis.toPrice, m.kpis.toPrice ? 'Price these lines in Zoho' : 'All lines found a price')}
${stat('Need a person', m.kpis.openAttention, m.kpis.openAttention ? 'See the list below' : 'Nothing waiting')}
</div>`;
}

function pipeline(m: OverviewModel): string {
  const stages = m.stages
    .map(
      (s, i) => `<div class="stage"><a class="cover" href="${s.href}" aria-label="${esc(s.label)}: ${s.count}"></a><div class="k">${esc(s.label)}</div><div class="c num"><span data-count="${s.count}">${s.count}</span></div><div class="bar"><svg viewBox="0 0 100 10" preserveAspectRatio="none" width="100%" height="12" aria-hidden="true"><rect class="hb f-s${i + 1}" width="${s.pct}" height="10"/></svg></div><div class="drop">${s.drop}</div></div>`,
    )
    .join('');
  return `<section class="panel rise d2" aria-labelledby="h-pipe"><div class="head"><div><h2 id="h-pipe">From inbox to draft</h2><p class="sub">What happened to the enquiries ${esc(RANGES.find((r) => r.key === m.range)?.phrase ?? '')}, step by step. Click a step to see them.</p></div></div><div class="pipe">${stages}</div></section>`;
}

function deskPanel(m: OverviewModel): string {
  const items = m.desk
    .map(
      (d) => `<li><span>${statusIcon(ICON[d.status] ?? 'neutral', 16)}</span><div><a class="who" href="/enquiry/${d.id}">${esc(d.who)}</a><div class="why">${esc(d.why)}</div><div class="sub">${esc(d.sender)}${d.subject ? ` · ${esc(d.subject.slice(0, 70))}` : ''}</div></div><span class="when">${esc(d.when)}</span></li>`,
    )
    .join('');
  const clear = `<div class="clear"><svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="17" fill="#e6f5e6"/><path d="M10 17.5l5 5 9-10" fill="none" stroke="#0ca30c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><div><b>You're all caught up.</b><div class="sub">Nothing is waiting for a person.</div></div></div>`;
  return `<section class="panel rise d3" aria-labelledby="h-desk"><div class="head"><div><h2 id="h-desk">Needs you</h2><p class="sub">Enquiries the assistant could not finish by itself, and what to do next.</p></div><a href="/enquiries?filter=attention">See all</a></div>${m.desk.length ? `<ul class="desk">${items}</ul>` : clear}${m.deskResolved ? `<p class="sub">${plural(m.deskResolved, 'earlier item was', 'earlier items were')} resolved automatically when the customer sent it again.</p>` : ''}${m.deskHandled ? `<p class="sub">${plural(m.deskHandled, 'item was', 'items were')} marked handled by your team.</p>` : ''}</section>`;
}

function outcomesPanel(m: OverviewModel): string {
  const total = m.outcomes.reduce((s, o) => s + o.count, 0);
  const cls = { good: 'f-good', warn: 'f-warn', crit: 'f-crit', neutral: 'f-neutral' } as const;
  const bar = stackedBar(m.outcomes.map((o) => ({ cls: cls[o.kind], value: o.count, tip: `${o.label}\n${o.count} of ${total}` })));
  const rows = m.outcomes
    .map((o) => `<div class="svc"><span>${statusIcon(o.kind, 16)}</span><span class="nm">${esc(o.label)}</span><span class="d"><b class="num">${o.count}</b>${total ? ` · ${Math.round((o.count / total) * 100)}%` : ''}</span></div>`)
    .join('');
  return `<section class="panel rise d4" aria-labelledby="h-out"><div class="head"><div><h2 id="h-out">How they ended</h2><p class="sub">Every enquiry ${esc(RANGES.find((r) => r.key === m.range)?.phrase ?? '')}, by result.</p></div></div><figure>${bar}</figure>${rows}</section>`;
}

function customersPanel(m: OverviewModel): string {
  const bars = hbars(m.topCustomers.map((c) => ({ label: c.name, value: Math.max(c.total, 0.01), display: c.display, tip: `${c.name}\n${plural(c.drafts, 'draft', 'drafts')} · ${c.display}` })));
  const table = tableView('Top customers by draft value', ['Customer', 'Drafts', 'Value'], m.topCustomers.map((c) => [c.name, String(c.drafts), c.display]));
  return `<section class="panel rise d5" aria-labelledby="h-cust"><div class="head"><div><h2 id="h-cust">Biggest drafts by customer</h2><p class="sub">Total value of the draft quotes waiting in Zoho Books.</p></div></div>${m.topCustomers.length ? `<figure>${bars}</figure>${table}` : '<div class="empty">Customers appear here once drafts are created.</div>'}</section>`;
}

function heatPanel(m: OverviewModel): string {
  const grid = heatmap(m.heat, (r, c, v) => `${WEEKDAYS[r]} ${hourLabel(c * 2)}–${hourLabel(c * 2 + 2)}\n${plural(v, 'enquiry', 'enquiries')}`);
  const table = tableView('Enquiries by weekday and time of day', ['Day', ...Array.from({ length: 12 }, (_, c) => hourLabel(c * 2))], m.heat.map((row, r) => [WEEKDAYS[r] ?? '', ...row.map(String)]));
  return `<section class="panel rise d6" aria-labelledby="h-heat"><div class="head"><div><h2 id="h-heat">Busiest times</h2><p class="sub">When enquiries tend to arrive (last 90 days, your local time). Darker means busier.</p></div></div>${m.heatTotal ? `<figure>${grid}</figure>${table}` : '<div class="empty">The pattern appears after the first few enquiries.</div>'}</section>`;
}

// --- pages -----------------------------------------------------------------------------------------------------------------------

export function overviewPage(m: OverviewModel, config: Config, now: Date, viewer: Viewer, brand?: Brand): string {
  const tz = config.timezone;
  const bigNum = m.hero.hours > 0 ? `<span data-count="${m.hero.hours}">${m.hero.hours}</span><small>h</small> <span data-count="${m.hero.mins}">${m.hero.mins}</span><small>m</small>` : `<span data-count="${m.hero.mins}">${m.hero.mins}</span><small>min</small>`;
  const hero = `<section class="hero"><div class="in">
<div class="rise"><p class="hello">${esc(m.dateLine)}</p><h1>${esc(m.greeting)}${m.clientName ? `, ${esc(m.clientName)}` : ''}.</h1><p class="lede">${esc(m.lede)}</p>
<div class="eyebrow">Manual quoting time saved · ${esc(m.rangeLabel.toLowerCase())}</div><div class="bignum num">${bigNum}</div><p class="equiv">${esc(m.hero.equiv)}</p>
<div class="chips">${m.chips.map((c) => `<span class="chip"><b>${esc(c.value)}</b> ${esc(c.label)}</span>`).join('')}</div></div>
<div class="panel rise d2"><div class="head"><div><h2>The last 14 days</h2><p class="sub">Draft quotes created each day. Hover a bar for the numbers.</p></div></div>
<div class="legend"><span><i class="f-blue"></i>Draft quotes</span><span><i class="f-crit"></i>Needed a person</span></div>
<figure>${activityChart(m.days)}</figure>${tableView('Draft quotes per day', ['Day', 'Drafts', 'Needed a person'], m.days.map((d) => [d.tip.split('\n')[0] ?? '', String(d.drafts), String(d.attention)]))}</div>
</div></section>`;

  const ranges = `<div class="range rise" role="group" aria-label="Time range">${RANGES.map((r) => `<a href="/?range=${r.key}"${r.key === m.range ? ' class="on" aria-current="true"' : ''}>${esc(r.label)}</a>`).join('')}</div>`;
  const body = `${ranges}${statStrip(m)}<div class="row">${pipeline(m)}</div>
<div class="row r32">${deskPanel(m)}${outcomesPanel(m)}</div>
<div class="row r23">${customersPanel(m)}${heatPanel(m)}</div>
<section class="panel rise" aria-labelledby="h-rec"><div class="head"><div><h2 id="h-rec">Recent enquiries</h2><p class="sub">The latest emails and what became of them.</p></div><a href="/enquiries">See all</a></div>${ledger(m.recent, tz, now)}</section>
<p class="sub foot">Draft quotes are never sent to customers. Review and send them from Zoho Books. This page only shows what happened.</p>`;
  return layout({ title: 'Overview', active: 'overview', clientName: m.clientName, viewer, ...(brand ? { brand } : {}), demo: m.demo, live: m.live, ...(m.banner ? { banner: m.banner } : {}), hero, body, refreshSeconds: 60 });
}

export function enquiriesPage(opts: { clientName: string; viewer: Viewer; brand?: Brand; canExport: boolean; rows: Enquiry[]; total: number; filter: string; page: number; pages: number; tz: string; now: Date; demo: boolean; live: OverviewModel['live']; banner?: OverviewModel['banner'] }): string {
  const tabs = FILTERS.map((f) => `<a href="/enquiries?filter=${f.key}"${f.key === opts.filter ? ' class="on"' : ''}>${esc(f.label)}</a>`).join('');
  const pager = opts.pages > 1 ? `<div class="pager">${opts.page > 1 ? `<a href="/enquiries?filter=${opts.filter}&amp;page=${opts.page - 1}">← Newer</a>` : ''}<span>Page ${opts.page} of ${opts.pages}</span>${opts.page < opts.pages ? `<a href="/enquiries?filter=${opts.filter}&amp;page=${opts.page + 1}">Older →</a>` : ''}</div>` : '';
  const body = `<h1 class="pt">Enquiries</h1><p class="sub ptsub">${plural(opts.total, 'enquiry', 'enquiries')} in this view.${opts.canExport ? ` <a class="btn ghost sm" href="/enquiries.csv?filter=${esc(opts.filter)}">Download as CSV</a>` : ''}</p><div class="tabs">${tabs}</div><section class="panel">${ledger(opts.rows, opts.tz, opts.now)}${pager}</section>`;
  return layout({ title: 'Enquiries', active: 'enquiries', clientName: opts.clientName, viewer: opts.viewer, ...(opts.brand ? { brand: opts.brand } : {}), demo: opts.demo, live: opts.live, ...(opts.banner ? { banner: opts.banner } : {}), body });
}

const FLAG_HELP: Record<string, string> = {
  LARGE_QUANTITY: 'A quantity is unusually large. Check it is not a typo before sending.',
  LARGE_TOTAL: 'The quote total is unusually large. Check quantities and prices before sending.',
  FRACTIONAL_UNITS: 'A fractional quantity for a counted unit, such as 2.5 pieces.',
  DUPLICATE_ITEM: 'The same item code appears on more than one row. Both lines were kept.',
  AI_ITEM_MATCH: "One or more lines were matched to a catalogue item by the AI from the customer's own wording. Each says [AI MATCH - PLEASE CHECK] in the quote. Check them before sending.",
};

export interface CustomerFormView {
  values: CustomerDraft;
  /** This person's role may add customers. */
  canCreate: boolean;
  /** The dashboard has a Zoho Books connection to add them with. */
  available: boolean;
  /** The email is still being kept, so the quote follows by itself. */
  held: boolean;
  /** Someone added the customer a few minutes ago, so the quote is on its way: show that instead of the form. */
  addedRecently?: boolean;
}

export function enquiryPage(opts: { recheck?: { canDo: boolean; everyMinutes: number }; customerForm?: CustomerFormView; flashBad?: boolean; clientName: string; viewer: Viewer; brand?: Brand; e: Enquiry; audit: Array<{ event: string; detail: string | null; at: string }>; notices: Array<{ kind: string; sentAt: string }>; notes: EnquiryNote[]; handled: boolean; flash?: string; tz: string; now: Date; demo: boolean; live: OverviewModel['live']; banner?: OverviewModel['banner'] }): string {
  const { e, tz } = opts;
  const name = e.customerName || e.companyInEmail || e.senderEmail;
  const url = safeUrl(e.quoteUrl);
  const draft = e.status === 'QUOTE_CREATED' || e.status === 'QUOTE_CREATED_WITH_EXCEPTIONS';
  const tier = e.matchTier === 'email' ? 'sender email' : e.matchTier === 'domain' ? 'email domain' : e.matchTier === 'company_name' ? 'company name in the email' : null;
  const rows: Array<[string, string]> = [
    ['From', esc(e.senderEmail)],
    ['Subject', esc(e.subject || '(none)')],
    ['Received', esc(fmtDateTime(e.emailDate ?? e.createdAt, tz))],
    ['Excel file', esc(e.attachmentName ?? 'None attached')],
    ...(e.companyInEmail ? ([['Company in the email', esc(e.companyInEmail)]] as Array<[string, string]>) : []),
    ...(e.customerName ? ([['Matched customer', `${esc(e.customerName)}${tier ? ` <span class="sub">· by ${esc(tier)}</span>` : ''}`]] as Array<[string, string]>) : []),
    ...(draft ? ([['Lines', `${e.lineCount ?? 0} read · ${e.matchedCount ?? 0} priced · ${e.unmatchedCount ?? 0} to price${e.unreadableRows ? ` · ${e.unreadableRows} unreadable` : ''}`], ['Quote total', esc(fmtMoney(e.totalAmount, e.currencyCode))], ['Quote number', url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(e.estimateNumber ?? '')} ↗</a>` : esc(e.estimateNumber ?? '')]] as Array<[string, string]>) : []),
    ['Attempts', String(e.attempts)],
  ];
  const needs = !opts.handled && !opts.customerForm?.addedRecently && ['NEEDS_INFO', 'HALTED_CUSTOMER_NOT_FOUND', 'HALTED_CUSTOMER_AMBIGUOUS', 'FAILED'].includes(e.status) ? `<section class="panel mb"><h2>What to do next</h2><p class="p0">${esc(attentionReason(e))}</p></section>` : '';
  const flags = e.reviewFlags.length ? `<section class="panel mb"><h2>Please check before sending</h2>${e.reviewFlags.map((f) => `<p class="p8"><span class="flag nm0">${esc(REVIEW_FLAG_TEXT[f] ?? f)}</span>${esc(FLAG_HELP[f] ?? '')}</p>`).join('')}</section>` : '';
  const timeline = opts.audit
    .map((a) => {
      const d = describeEvent(a.event, a.detail);
      return `<li><span class="at num">${esc(fmtDateTime(a.at, tz))}</span><span class="pt"></span><div><div class="what">${esc(d.what)}</div>${d.more ? `<div class="more">${esc(d.more)}</div>` : ''}</div></li>`;
    })
    .join('');
  const lastHandled = [...opts.notes].reverse().find((n) => n.kind === 'handled');
  const handledChip = opts.handled && lastHandled ? `<span class="st good">${statusIcon('good', 13)}Handled by ${esc(lastHandled.author)}</span>` : '';
  const canNote = can(opts.viewer.role, 'enquiries.annotate');
  const noteItems = opts.notes
    .map((n) => {
      const what = n.kind === 'handled' ? 'marked this as handled' : n.kind === 'reopened' ? 'reopened this' : 'left a note';
      return `<li class="note ${n.kind}"><span class="av sm" aria-hidden="true">${esc(initials(n.author))}</span><div><div class="by"><b>${esc(n.author)}</b> ${what} <span class="sub">· ${esc(fmtDateTime(n.createdAt, tz))}</span></div>${n.body ? `<p class="txt">${esc(n.body)}</p>` : ''}</div></li>`;
    })
    .join('');
  const noteForm = canNote
    ? `<form method="post" action="/enquiry/${e.id}/note" class="form"><input type="hidden" name="_csrf" value="${esc(opts.viewer.csrf)}"><label for="nb">Add a note for your team</label><textarea id="nb" name="body" rows="3" maxlength="500" placeholder="For example: called the customer, resending a clearer Excel"></textarea><div class="actions"><button class="btn" type="submit">Save note</button>${opts.handled ? `<button class="btn ghost" type="submit" formaction="/enquiry/${e.id}/reopen" formnovalidate>Reopen</button>` : `<button class="btn ghost" type="submit" formaction="/enquiry/${e.id}/handled" formnovalidate>Mark as handled</button>`}</div></form>`
    : `<p class="sub p0">Your role (${esc(opts.viewer.role)}) can read notes but not add them. Ask a manager if something should be recorded.</p>`;
  const cf = opts.customerForm;
  const customerPanel = cf?.addedRecently
    ? `<section class="panel mb" aria-labelledby="h-addcust"><h2 id="h-addcust">Customer added to Zoho Books</h2><p class="p0">${cf.held ? 'The quote is created automatically within a couple of minutes. Nobody needs to resend the email.' : 'This email is no longer being kept, so ask the sender to resend it.'} If nothing has happened after about 15 minutes, this form comes back so the details can be checked again.</p></section>`
    : cf
    ? (() => {
        const v = cf.values;
        const input = (id: string, label: string, name: string, value: string, max: number, required = false): string =>
          `<div><label for="${id}">${esc(label)}</label><input id="${id}" name="${name}" type="text" value="${esc(value)}" maxlength="${max}" autocomplete="off"${required ? ' required' : ''}></div>`;
        const next = cf.held
          ? 'Adding the customer is the only step left. The email is being kept, and the quote is created automatically within a couple of minutes.'
          : 'This email is no longer being kept, so after adding the customer, ask the sender to resend it.';
        const flashHtml = opts.flash && opts.flashBad ? `<p class="badmsg" role="alert">${esc(opts.flash)}</p>` : '';
        const body =
          cf.canCreate && cf.available
            ? `<form class="form cols" method="post" action="/enquiry/${e.id}/customer">${csrfField(opts.viewer)}${input('c-co', 'Company name', 'company', v.companyName, 100, true)}${input('c-ct', 'Contact person', 'contact', v.contactName, 80)}${input('c-em', 'Email', 'email', v.email, 254)}${input('c-ph', 'Phone', 'phone', v.phone, 20)}${input('c-ad', 'Address', 'address', v.address, 200)}${input('c-ci', 'City', 'city', v.city, 60)}${input('c-st', 'State', 'state', v.state, 40)}${input('c-zp', 'PIN code', 'zip', v.zip, 6)}${input('c-gs', 'GST number (if given)', 'gstin', v.gstin, 15)}<div class="actions"><button class="btn" type="submit">Add to Zoho Books</button></div></form>`
            : `<dl class="facts">${[['Company', v.companyName], ['Contact', v.contactName], ['Email', v.email], ['Phone', v.phone], ['Address', [v.address, v.city, v.state, v.zip].filter(Boolean).join(', ')], ['GST number', v.gstin]]
                .filter(([, val]) => val)
                .map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`)
                .join('')}</dl><p class="sub p8">${cf.canCreate ? 'Adding customers from here needs the quote service to be running. Add the customer in Zoho Books instead.' : `Your role (${esc(opts.viewer.role)}) cannot add customers. Ask a staff member or manager.`}</p>`;
        return `<section class="panel mb" aria-labelledby="h-addcust"><h2 id="h-addcust">Add this customer to Zoho Books</h2><p class="sub">These details were read from the email. Check them, fix anything that is wrong, then add the customer. Nothing is created until a person clicks the button.</p>${flashHtml}${body}<p class="sub p8">${esc(next)}</p></section>`;
      })()
    : '';
  const rc = opts.recheck;
  const recheckPanel = rc && !cf?.addedRecently
    ? `<section class="panel mb" aria-labelledby="h-recheck"><h2 id="h-recheck">Fixed it in Zoho Books yourself?</h2><p class="sub">If you added or corrected the customer directly in Zoho Books, ask the assistant to look again now. It will make the quote within a couple of minutes. Otherwise it looks again by itself every ${rc.everyMinutes} minutes.</p>${rc.canDo ? `<form method="post" action="/enquiry/${e.id}/recheck" class="form">${csrfField(opts.viewer)}<div class="actions"><button class="btn ghost" type="submit">Check again now</button></div></form>` : `<p class="sub p8">Your role (${esc(opts.viewer.role)}) cannot do this. Ask a staff member or manager.</p>`}</section>`
    : '';
  const notesPanel = `<section class="panel mb" aria-labelledby="h-notes"><h2 id="h-notes">Team notes</h2><p class="sub">Kept on this server only. Nothing here is written to Zoho Books.</p>${opts.flash && !opts.flashBad ? `<p class="okmsg" role="status">${esc(opts.flash)}</p>` : ''}${noteItems ? `<ul class="notes">${noteItems}</ul>` : '<p class="sub">No notes yet.</p>'}${noteForm}</section>`;
  const body = `<p class="back"><a href="/enquiries">← All enquiries</a></p>
<div class="head mid"><h1 class="pt big">${esc(name)}</h1>${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open the quote in Zoho Books ↗</a>` : ''}</div>
<p class="chipsrow">${statusChip(e.status)}${handledChip}${flagChips(e.reviewFlags)}</p>
${needs}${customerPanel}${recheckPanel}${flags}${notesPanel}
<div class="row r2"><section class="panel"><h2>The enquiry</h2><p class="sub">What came in, and what it became.</p><dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></section>
<section class="panel"><h2>What the assistant did</h2><p class="sub">Step by step, in order.</p><ol class="tl">${timeline}</ol></section></div>`;
  return layout({ title: `${name}`, active: 'enquiries', clientName: opts.clientName, viewer: opts.viewer, ...(opts.brand ? { brand: opts.brand } : {}), demo: opts.demo, live: opts.live, ...(opts.banner ? { banner: opts.banner } : {}), body });
}

export function statusPage(opts: { recipients: { sales: string[]; stakeholders: string[] }; usage: { drafts: number; aiCalls: number; tokensIn: number; tokensOut: number; costUsd: number }; config: Config; services: ServiceRow[]; clientName: string; viewer: Viewer; brand?: Brand; demo: boolean; live: OverviewModel['live']; banner?: OverviewModel['banner']; startedAt?: string; now: Date }): string {
  const { config } = opts;
  const dot = (k: ServiceRow['kind']): string => `<span class="dot ${k === 'ok' ? 'ok' : k}"></span>`;
  const rows = opts.services.map((s) => `<div class="svc">${dot(s.kind)}<span class="nm">${esc(s.name)}<div class="sub">${esc(s.state)}</div></span><span class="d">${esc(s.detail)}</span></div>`).join('');
  const settings: Array<[string, string]> = [
    ['Mailbox checked', config.schedule.cron === '*/2 * * * *' ? 'Every 2 minutes' : `On schedule: ${config.schedule.cron}`],
    ['Quote validity', `${config.quote.validityDays} days from the day it is created`],
    ['Time zone', config.timezone],
    ['Alert emails go to', opts.recipients.sales.join(', ')],
    ['Items-to-price alerts go to', opts.recipients.stakeholders.join(', ')],
    ['This month so far', `${opts.usage.drafts} draft ${opts.usage.drafts === 1 ? 'quote' : 'quotes'} · ${opts.usage.aiCalls} AI calls · ${new Intl.NumberFormat('en-IN').format(opts.usage.tokensIn + opts.usage.tokensOut)} tokens${config.dashboard.showAiCost ? ` (about $${opts.usage.costUsd.toFixed(2)})` : ''}`],
    ['Daily summary', config.alerts.dailySummaryCron ? 'Sent every day' : 'Off'],
    ['Flags a quantity above', new Intl.NumberFormat('en-IN').format(config.review.warnQuantityAbove)],
    ['Flags a quote total above', new Intl.NumberFormat('en-IN').format(config.review.warnTotalAbove)],
    ['Kept records for', `${config.retentionDays} days`],
    ...(opts.startedAt ? ([['Running since', fmtDateTime(opts.startedAt, config.timezone)]] as Array<[string, string]>) : []),
  ];
  const body = `<h1 class="pt mb">Status</h1>
<div class="row r2"><section class="panel"><h2>What it is connected to</h2><p class="sub">Everything the assistant relies on.</p>${rows}</section>
<section class="panel"><h2>How it is set up</h2><p class="sub">Read-only. Ask support to change any of these.</p><dl class="facts">${settings.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section></div>`;
  return layout({ title: 'Status', active: 'status', clientName: opts.clientName, viewer: opts.viewer, ...(opts.brand ? { brand: opts.brand } : {}), demo: opts.demo, live: opts.live, ...(opts.banner ? { banner: opts.banner } : {}), body });
}

export function dataPage(opts: { config: Config; clientName: string; viewer: Viewer; brand?: Brand; demo: boolean; live: OverviewModel['live']; banner?: OverviewModel['banner'] }): string {
  const days = opts.config.retentionDays;
  const holdDays = opts.config.hold.days;
  const body = `<h1 class="pt">Your data</h1><p class="sub ptsub">Where everything lives, who can see it, and how long it is kept.</p>
<div class="three">
<section class="panel"><span class="eyebrow">In your Zoho Books</span><h3>Customers, items, prices, quotes</h3><p>All the business data stays in your own Zoho Books account. The assistant only <b>creates draft quotes</b>. It never sends one to a customer and never changes a customer or an item.</p></section>
<section class="panel"><span class="eyebrow">On this server</span><h3>A log of what happened</h3><p>For each email: who sent it, the subject, the Excel file name, the result, the quote number and total, and the steps taken. ${holdDays > 0 ? `<b>No email text and no Excel files are kept, with one exception:</b> an email from a customer who is not in your Zoho Books yet is held for up to <b>${holdDays} days</b>, together with the contact details read from its signature, so its quote can be made automatically once you add them. They are deleted as soon as the customer is added and the quote is made.` : '<b>No email text and no Excel files are stored.</b>'} Records are deleted after <b>${days} days</b>.</p></section>
<section class="panel"><span class="eyebrow">Sent to Claude, read once</span><h3>The text of the email</h3><p>To understand a messy email, its text (and a few top rows of an unusual spreadsheet) is sent to Anthropic's Claude to read. For item lines nothing else could match, the item descriptions from the Excel are sent too, together with the names of your catalogue items, so the AI can suggest the closest one. Our server does not keep any of it. How Anthropic handles it follows the terms of your Anthropic account.</p></section>
</div>
<div class="row r2 mt"><section class="panel"><h2>Your mailbox</h2><p class="sub p0">The original emails stay in your mailbox. The assistant marks them as read once handled and does not copy or delete them.</p></section>
<section class="panel"><h2>Keys and passwords</h2><p class="sub p0">Stored in a protected settings file on the server. They are never shown on this page or written to the logs.</p></section></div>
<section class="panel mt"><h2>Backups and removal</h2><p class="sub p0">The log is backed up every night and the last ${opts.config.backup.keep} backups are kept. To have your records removed earlier than ${days} days, or to ask any question about your data, contact support.</p></section>`;
  return layout({ title: 'Your data', active: 'data', clientName: opts.clientName, viewer: opts.viewer, ...(opts.brand ? { brand: opts.brand } : {}), demo: opts.demo, live: opts.live, ...(opts.banner ? { banner: opts.banner } : {}), body });
}

export function messagePage(title: string, message: string, viewer?: Viewer, brand?: Brand): string {
  return layout({ title, active: '', clientName: '', ...(viewer ? { viewer } : {}), ...(brand ? { brand } : {}), body: `<div class="msg"><h1 class="pt">${esc(title)}</h1><p class="sub lead">${esc(message)}</p></div>` });
}
