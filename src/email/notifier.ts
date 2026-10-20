import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config';
import { logger } from '../logger';
import { synthesizeExceptionNotice, type ExceptionFacts } from '../llm/emailExtractor';
import type { LlmClient } from '../llm/client';
import type { DailySummary } from '../ops/monitor';
import type { CustomerMatchTier, EnquiryMeta, SkippedRow, ZohoContact } from '../types';

/**
 * Internal notifications only. Recipients are restricted to the configured internal addresses, so a quotation
 * (or anything else) can never be emailed to the customer by this module.
 */

export interface EnquiryRef {
  enquiryId: number;
  senderEmail: string;
  senderName: string;
  subject: string;
  attachmentName: string | null;
  meta: EnquiryMeta | null;
}

export interface QuoteSummary {
  estimateNumber: string;
  total: number;
  currencyCode: string;
  url: string;
  validUntil: string;
}

export interface UnmatchedLineInfo {
  rowNumber: number;
  sku: string | null;
  description: string;
  quantity: number;
  reason: string;
}

export interface SendResult {
  delivered: boolean;
  dryRun: boolean;
}

export interface Notifier {
  /** Notification A: rows or quantities could not be read (a quote may or may not have been created). */
  additionalInfoRequired(ctx: {
    enquiry: EnquiryRef;
    reasons: string[];
    skipped: SkippedRow[];
    quote: QuoteSummary | null;
  }): Promise<SendResult>;
  /** Notification B: items with no Zoho match / no price were added as rate-0 lines. */
  unmatchedProducts(ctx: {
    enquiry: EnquiryRef;
    quote: QuoteSummary;
    unmatched: UnmatchedLineInfo[];
    totalLines: number;
  }): Promise<SendResult>;
  /** Notification C: a draft quotation exists. */
  draftCreated(ctx: {
    enquiry: EnquiryRef;
    quote: QuoteSummary;
    customerName: string;
    matchedBy: CustomerMatchTier;
    confidence: 'exact' | 'probable';
    counts: { lines: number; matched: number; unmatched: number; unreadableRows: number; droppedRows: number };
    warnings: string[];
  }): Promise<SendResult>;
  /** Processing halted: the customer is not in Zoho Books (or more than one customer fits). */
  customerNotFound(ctx: {
    enquiry: EnquiryRef;
    resolution: 'not_found' | 'ambiguous';
    candidates: ZohoContact[];
    tried: string[];
  }): Promise<SendResult>;
  processingFailed(ctx: { enquiry: EnquiryRef; error: string; attempts: number }): Promise<SendResult>;
  /** The mailbox/Zoho checks keep failing (kind "down", once per outage) or work again ("recovered"). */
  serviceAlert(ctx: { kind: 'down' | 'recovered'; detail: string; consecutiveFailures?: number }): Promise<SendResult>;
  /** One email a day: what happened, what still needs a person, and proof the service is alive. */
  dailySummary(summary: DailySummary): Promise<SendResult>;
}

// --- message rendering ---------------------------------------------------------------------------

interface Section {
  heading: string;
  rows?: Array<[label: string, value: string]>;
  bullets?: string[];
}

interface MailDoc {
  subject: string;
  to: string[];
  intro: string;
  sections: Section[];
  link?: { label: string; url: string };
  footer?: string;
}

const oneLine = (s: string, max = 200): string => s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderText(doc: MailDoc): string {
  const out: string[] = [doc.intro, ''];
  for (const s of doc.sections) {
    out.push(s.heading.toUpperCase());
    for (const [label, value] of s.rows ?? []) out.push(`  ${label}: ${value}`);
    for (const b of s.bullets ?? []) out.push(`  - ${b}`);
    out.push('');
  }
  if (doc.link) out.push(`${doc.link.label}: ${doc.link.url}`, '');
  if (doc.footer) out.push(doc.footer);
  return out.join('\n').trim();
}

function renderHtml(doc: MailDoc): string {
  const parts: string[] = [`<p>${escapeHtml(doc.intro)}</p>`];
  for (const s of doc.sections) {
    parts.push(`<h3 style="margin:16px 0 4px">${escapeHtml(s.heading)}</h3>`);
    if (s.rows?.length) {
      parts.push(
        '<table cellpadding="3" cellspacing="0">' +
          s.rows
            .map(([l, v]) => `<tr><td style="color:#555;padding-right:12px">${escapeHtml(l)}</td><td>${escapeHtml(v)}</td></tr>`)
            .join('') +
          '</table>',
      );
    }
    if (s.bullets?.length) parts.push('<ul>' + s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('') + '</ul>');
  }
  if (doc.link) parts.push(`<p><a href="${escapeHtml(doc.link.url)}">${escapeHtml(doc.link.label)}</a></p>`);
  if (doc.footer) parts.push(`<p style="color:#666">${escapeHtml(doc.footer)}</p>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">${parts.join('')}</div>`;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function enquirySection(e: EnquiryRef): Section {
  const rows: Array<[string, string]> = [
    ['From', e.senderName ? `${oneLine(e.senderName, 80)} <${e.senderEmail}>` : e.senderEmail],
    ['Subject', oneLine(e.subject) || '(none)'],
    ['Attachment', e.attachmentName ?? '(none)'],
  ];
  if (e.meta?.companyName) rows.push(['Company in email', e.meta.companyName]);
  if (e.meta?.contactName) rows.push(['Contact', e.meta.contactName]);
  return { heading: 'Enquiry', rows };
}

const MAX_LISTED = 25;
const listed = (items: string[]): string[] =>
  items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `…and ${items.length - MAX_LISTED} more`] : items;

// --- the notifier --------------------------------------------------------------------------------

export class MailNotifier implements Notifier {
  private transporter: Transporter | null = null;
  private readonly allowed: Set<string>;

  constructor(
    private readonly config: Config,
    private readonly llm: LlmClient,
  ) {
    this.allowed = new Set([config.notify.internal, ...config.notify.stakeholders].map((a) => a.toLowerCase()));
    if (!config.smtp) {
      logger.warn('SMTP_HOST is not set: notification emails are written to the log and NOT delivered.');
    }
  }

  async additionalInfoRequired(ctx: Parameters<Notifier['additionalInfoRequired']>[0]): Promise<SendResult> {
    const intro = await this.intro({
      kind: 'additional_info',
      sender: ctx.enquiry.senderEmail,
      subject: ctx.enquiry.subject,
      points: [...ctx.reasons, ...(ctx.quote ? ['A draft quotation was still created from the rows that could be read.'] : [])],
    });
    const sections: Section[] = [
      enquirySection(ctx.enquiry),
      { heading: 'What is missing', bullets: ctx.reasons },
    ];
    if (ctx.skipped.length > 0) {
      sections.push({
        heading: 'Rows that need a person to look at them',
        bullets: listed(ctx.skipped.map((s) => `Row ${s.rowNumber}: ${s.reason}${s.preview ? ` — ${s.preview}` : ''}`)),
      });
    }
    return this.deliver({
      subject: `[Quote agent] More information needed: ${oneLine(ctx.enquiry.subject, 120) || ctx.enquiry.senderEmail}`,
      to: [this.config.notify.internal],
      intro,
      sections,
      ...(ctx.quote ? { link: { label: 'Open the draft quotation in Zoho Books', url: ctx.quote.url } } : {}),
    });
  }

  async unmatchedProducts(ctx: Parameters<Notifier['unmatchedProducts']>[0]): Promise<SendResult> {
    const intro = await this.intro({
      kind: 'unmatched_products',
      sender: ctx.enquiry.senderEmail,
      subject: ctx.enquiry.subject,
      points: [
        `${ctx.unmatched.length} of ${ctx.totalLines} items were added at rate 0.00 with the note "[UNMATCHED ITEM - MANUAL PRICING REQUIRED]".`,
        `Draft quotation ${ctx.quote.estimateNumber} was created.`,
      ],
    });
    return this.deliver({
      subject: `[Quote agent] ${ctx.unmatched.length} item(s) need manual pricing: draft ${ctx.quote.estimateNumber}`,
      to: this.config.notify.stakeholders,
      intro,
      sections: [
        enquirySection(ctx.enquiry),
        {
          heading: 'Items needing manual pricing',
          bullets: listed(
            ctx.unmatched.map(
              (u) =>
                `Row ${u.rowNumber} · ${u.sku ?? 'no code'} · ${oneLine(u.description, 80)} · qty ${u.quantity} · ${u.reason}`,
            ),
          ),
        },
      ],
      link: { label: 'Open the draft quotation in Zoho Books', url: ctx.quote.url },
    });
  }

  async draftCreated(ctx: Parameters<Notifier['draftCreated']>[0]): Promise<SendResult> {
    const { quote, counts } = ctx;
    const sections: Section[] = [
      {
        heading: 'Draft quotation',
        rows: [
          ['Number', quote.estimateNumber],
          ['Customer', ctx.customerName],
          ['Matched by', `${ctx.matchedBy.replace('_', ' ')}${ctx.confidence === 'probable' ? ' (probable, please verify)' : ''}`],
          ['Total (incl. tax)', money(quote.total, quote.currencyCode)],
          ['Valid until', quote.validUntil],
          ['Line items', `${counts.lines} (${counts.matched} priced by Zoho, ${counts.unmatched} need manual pricing)`],
          ...(counts.unreadableRows > 0 ? ([['Unreadable rows', String(counts.unreadableRows)]] as Array<[string, string]>) : []),
          ...(counts.droppedRows > 0 ? ([['Ignored rows', `${counts.droppedRows} (totals, headings, zero/negative quantities)`]] as Array<[string, string]>) : []),
        ],
      },
      enquirySection(ctx.enquiry),
    ];
    const meta = ctx.enquiry.meta;
    const requirements: string[] = [];
    if (meta?.deliveryTimeline) requirements.push(`Delivery: ${meta.deliveryTimeline}`);
    if (meta?.deliveryAddress) requirements.push(`Ship to: ${meta.deliveryAddress}`);
    if (meta?.specialNotes) requirements.push(`Notes: ${meta.specialNotes}`);
    if (requirements.length > 0) sections.push({ heading: 'Customer requirements (from the email)', bullets: requirements });
    if (ctx.warnings.length > 0) sections.push({ heading: 'Please check', bullets: ctx.warnings });

    return this.deliver({
      subject: `[Quote agent] Draft quotation ${quote.estimateNumber} created for ${oneLine(ctx.customerName, 80)}`,
      to: [this.config.notify.internal],
      intro: `A draft quotation was created in Zoho Books for the enquiry below.`,
      sections,
      link: { label: 'Open in Zoho Books', url: quote.url },
      footer: 'This is a DRAFT. Nothing has been sent to the customer.',
    });
  }

  async customerNotFound(ctx: Parameters<Notifier['customerNotFound']>[0]): Promise<SendResult> {
    const ambiguous = ctx.resolution === 'ambiguous';
    const intro = await this.intro({
      kind: ambiguous ? 'customer_ambiguous' : 'customer_not_found',
      sender: ctx.enquiry.senderEmail,
      subject: ctx.enquiry.subject,
      points: [
        ambiguous
          ? 'More than one Zoho Books customer matches this sender; none was chosen automatically.'
          : 'No customer matched by sender email, email domain, or company name.',
        'Customers are never created automatically.',
      ],
    });
    const sections: Section[] = [
      enquirySection(ctx.enquiry),
      { heading: 'Lookups tried', bullets: ctx.tried },
    ];
    if (ctx.candidates.length > 0) {
      sections.push({
        heading: 'Possible matches in Zoho Books',
        bullets: ctx.candidates.slice(0, 10).map((c) => `${c.company_name || c.contact_name}${c.email ? ` <${c.email}>` : ''}`),
      });
    }
    sections.push({
      heading: 'What to do',
      bullets: [
        ambiguous
          ? 'Decide which customer this sender belongs to and make the sender email / company name unambiguous in Zoho Books.'
          : 'Create the customer in Zoho Books with a valid GSTIN / PAN and Place of Supply.',
        'Then ask the sender to resend the enquiry (or forward it to the monitored inbox) so the draft quotation is created.',
      ],
    });
    return this.deliver({
      subject: `[Quote agent] ${ambiguous ? 'Ambiguous customer' : 'Customer not found'}: ${oneLine(ctx.enquiry.senderEmail, 80)}`,
      to: [this.config.notify.internal],
      intro,
      sections,
    });
  }

  async processingFailed(ctx: Parameters<Notifier['processingFailed']>[0]): Promise<SendResult> {
    const intro = await this.intro({
      kind: 'processing_failed',
      sender: ctx.enquiry.senderEmail,
      subject: ctx.enquiry.subject,
      points: [`${ctx.attempts} automatic attempts failed.`, `Last error: ${oneLine(ctx.error, 300)}`],
    });
    return this.deliver({
      subject: `[Quote agent] Processing failed: ${oneLine(ctx.enquiry.subject, 100) || ctx.enquiry.senderEmail}`,
      to: [this.config.notify.internal],
      intro,
      sections: [
        enquirySection(ctx.enquiry),
        { heading: 'Failure', rows: [['Attempts', String(ctx.attempts)], ['Last error', oneLine(ctx.error, 500)]] },
        { heading: 'What to do', bullets: ['Create the quotation manually, or fix the cause and ask the sender to resend the enquiry.'] },
      ],
    });
  }

  async serviceAlert(ctx: Parameters<Notifier['serviceAlert']>[0]): Promise<SendResult> {
    const down = ctx.kind === 'down';
    return this.deliver({
      subject: down ? '[Quote agent] SERVICE PROBLEM: emails are not being processed' : '[Quote agent] Service recovered',
      to: [this.config.notify.internal],
      intro: down
        ? `The quote assistant could not check the mailbox ${ctx.consecutiveFailures ?? 'several'} times in a row. New enquiries are NOT being turned into draft quotes until this is fixed.`
        : 'The quote assistant is checking the mailbox normally again. Enquiries that arrived during the problem are picked up automatically.',
      sections: [
        { heading: down ? 'Last error' : 'Status', rows: [['Detail', oneLine(ctx.detail, 400)]] },
        ...(down
          ? [{ heading: 'What to check', bullets: ['The mailbox password (or app password) has not changed or expired.', 'The mail provider is reachable.', 'Zoho Books access has not been revoked.', 'If it keeps failing, contact support.'] }]
          : []),
      ],
      ...(this.config.dashboard.publicUrl ? { link: { label: 'Open the dashboard', url: this.config.dashboard.publicUrl } } : {}),
    });
  }

  async dailySummary(s: DailySummary): Promise<SendResult> {
    const hm = (m: number): string => `${Math.floor(m / 60)} h ${Math.round(m % 60)} m`;
    const sections: Section[] = [
      {
        heading: 'Last 24 hours',
        rows: [
          ['Enquiries received', String(s.received)],
          ['Draft quotes created', `${s.drafts}${s.draftsToPrice > 0 ? ` (${s.draftsToPrice} with items to price)` : ''}`],
          ...(s.flaggedForReview > 0 ? ([['Marked for review', `${s.flaggedForReview} (unusual quantity or total)`]] as Array<[string, string]>) : []),
          ['Estimated time saved', hm(s.timeSavedMinutes)],
          ...(s.timeSavedValue && s.timeSavedValue.amount > 0
            ? ([['Worth about', new Intl.NumberFormat('en-IN', { style: 'currency', currency: s.timeSavedValue.currency, maximumFractionDigits: 0 }).format(s.timeSavedValue.amount) + ' of staff time']] as Array<[string, string]>)
            : []),
          ...(this.config.dashboard.showAiCost ? ([['AI usage', `${s.llm.calls} calls, about $${s.llm.estimatedUsd.toFixed(4)}`]] as Array<[string, string]>) : []),
        ],
      },
      {
        heading: 'Service',
        rows: [
          ['Mailbox checks', s.health.ok ? 'working' : `PROBLEM: ${s.health.reason ?? 'unknown'}`],
          ['Last backup', s.backup.lastAt ? `${s.backup.lastAt.slice(0, 16).replace('T', ' ')} UTC${s.backup.ok ? '' : ' (the last attempt FAILED)'}` : 'none yet'],
        ],
      },
    ];
    if (s.needAttention.length > 0) {
      sections.push({
        heading: 'Still needs a person (last 7 days)',
        bullets: listed(s.needAttention.map((n) => `${oneLine(n.sender, 60)}: ${oneLine(n.subject, 60) || '(no subject)'}. ${n.reason}`)),
      });
    }
    const quiet = s.received === 0 && s.needAttention.length === 0;
    return this.deliver({
      subject: `[Quote agent] Daily summary ${s.date}: ${s.received} received, ${s.drafts} draft${s.drafts === 1 ? '' : 's'}${s.needAttention.length ? `, ${s.needAttention.length} need attention` : ''}`,
      to: [this.config.notify.internal],
      intro: quiet ? 'No enquiries arrived in the last 24 hours and nothing is waiting. The service is running.' : 'Here is what the quote assistant did in the last 24 hours.',
      sections,
      ...(s.dashboardUrl ? { link: { label: 'Open the dashboard', url: s.dashboardUrl } } : {}),
      footer: 'Draft quotes are never sent to customers. Review them in Zoho Books before sending.',
    });
  }

  // --- internals ---------------------------------------------------------------------------------

  private intro(facts: ExceptionFacts): Promise<string> {
    return synthesizeExceptionNotice(this.llm, facts);
  }

  private getTransporter(): Transporter | null {
    const smtp = this.config.smtp;
    if (!smtp) return null;
    this.transporter ??= nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure,
      ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    return this.transporter;
  }

  private async deliver(doc: MailDoc): Promise<SendResult> {
    for (const address of doc.to) {
      if (!this.allowed.has(address.toLowerCase())) {
        throw new Error(`Refusing to email ${address}: only configured internal recipients are allowed`);
      }
    }
    const text = renderText(doc);
    const transporter = this.getTransporter();
    if (!transporter) {
      logger.info(`[mail:not-sent] To: ${doc.to.join(', ')} | Subject: ${doc.subject}\n${text}\n`);
      return { delivered: false, dryRun: true };
    }

    const message = {
      from: this.config.notify.from,
      to: doc.to,
      subject: oneLine(doc.subject, 200),
      text,
      html: renderHtml(doc),
      // Marks this as automatic mail so that, if it lands in the monitored mailbox, it is never read as an enquiry.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Quote-Assistant': 'alert', Precedence: 'bulk', 'X-Auto-Response-Suppress': 'All' },
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await transporter.sendMail(message);
        logger.info('Notification sent', { to: doc.to, subject: message.subject });
        return { delivered: true, dryRun: false };
      } catch (err) {
        const e = err as { code?: string; responseCode?: number; message?: string };
        const transient =
          ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS'].includes(e.code ?? '') ||
          (e.responseCode !== undefined && e.responseCode >= 400 && e.responseCode < 500);
        if (!transient || attempt >= 3) throw err;
        logger.warn('SMTP send failed; retrying', { attempt, error: e.message });
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt * attempt));
      }
    }
  }
}
