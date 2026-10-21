import { ConfigError, getConfig, requireZoho, type Config, type ZohoConfig } from '../config';
import { openDatabase, type Db } from '../db';
import { Repository } from '../db/repository';
import { ImapMailbox } from '../email/imapClient';
import { computeKeys, parseRawEmail, sha256Hex } from '../email/mailParser';
import {
  isOwnAlertSubject,
  MailNotifier,
  type EnquiryRef,
  type Notifier,
  type QuoteSummary,
  type UnmatchedLineInfo,
} from '../email/notifier';
import { ExcelParseError, parseRfq } from '../excel/parser';
import { normalizeUom } from '../excel/normalizer';
import { LlmClient } from '../llm/client';
import { extractCustomerDraft } from '../llm/customerExtractor';
import { extractEmailMetadata, heuristicMeta } from '../llm/emailExtractor';
import { createColumnResolver } from '../llm/headerResolver';
import { errorMessage, logger, setLogLevel } from '../logger';
import type {
  ColumnResolver,
  InboundMail,
  MailAttachment,
  MatchedLine,
  NotificationKind,
  ParseResult,
  ZohoApi,
} from '../types';
import { ZohoClient } from '../zoho/client';
import { CustomerDirectory, resolveCustomer } from '../zoho/customerService';
import { ItemCatalog } from '../zoho/itemService';
import { buildEstimatePayload, calendarDate, createDraftEstimate, findEstimateByReference, quoteUrl } from '../zoho/quoteService';
import { reviewFindings } from './sanity';

/** Everything the workflow needs, wired once. Tests and the mock run swap individual parts. */
export interface Runtime {
  config: Config;
  zohoConfig: ZohoConfig;
  db: Db;
  repo: Repository;
  llm: LlmClient;
  zoho: ZohoApi;
  catalog: ItemCatalog;
  customers: CustomerDirectory;
  notifier: Notifier;
  mailbox: ImapMailbox | null;
  resolveColumns: ColumnResolver;
  clock: () => Date;
  close(): void;
}

export interface RuntimeOverrides {
  zoho?: ZohoApi;
  zohoConfig?: ZohoConfig;
  notifier?: Notifier;
  llm?: LlmClient;
  mailbox?: ImapMailbox | null;
  clock?: () => Date;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  // Validate everything that can fail on configuration BEFORE opening the database.
  const zohoConfig = overrides.zohoConfig ?? requireZoho(config);
  const db = openDatabase(config.dbPath);
  const clock = overrides.clock ?? (() => new Date());
  const repo = new Repository(db, {
    dedupeWindowHours: config.limits.dedupeWindowHours,
    maxAttempts: config.limits.maxAttempts,
    staleProcessingMinutes: config.limits.staleProcessingMinutes,
    now: clock,
  });
  const llm =
    overrides.llm ??
    new LlmClient(config.llm, {
      onUsage: (task, inputTokens, outputTokens) =>
        repo.addLlmUsage(calendarDate(clock(), config.timezone), task, 1, inputTokens, outputTokens),
    });
  const zoho = overrides.zoho ?? new ZohoClient(zohoConfig);
  return {
    config,
    zohoConfig,
    db,
    repo,
    llm,
    zoho,
    catalog: new ItemCatalog(zoho),
    customers: new CustomerDirectory(zoho),
    notifier: overrides.notifier ?? new MailNotifier(config, llm),
    mailbox: overrides.mailbox !== undefined ? overrides.mailbox : config.imap ? new ImapMailbox(config.imap, config.imapBatchLimit) : null,
    resolveColumns: createColumnResolver(llm),
    clock,
    close: () => db.close(),
  };
}

// --- results -------------------------------------------------------------------------------------

export type UnitOutcome =
  | 'quote_created'
  | 'quote_created_with_exceptions'
  | 'needs_info'
  | 'halted_customer'
  | 'duplicate'
  | 'ignored_automatic'
  | 'in_progress'
  | 'failed_will_retry'
  | 'failed_exhausted';

export interface UnitResult {
  attachment: string | null;
  outcome: UnitOutcome;
  enquiryId?: number;
  quote?: QuoteSummary;
}

/** Outcomes after which the email may be flagged \Seen: nothing further will happen for it automatically. */
const FINAL: ReadonlySet<UnitOutcome> = new Set<UnitOutcome>([
  'quote_created',
  'quote_created_with_exceptions',
  'needs_info',
  'halted_customer',
  'duplicate',
  'ignored_automatic',
  'failed_exhausted',
]);

export interface MessageResult {
  handled: boolean;
  messageId: string;
  results: UnitResult[];
}

interface Unit {
  mail: InboundMail;
  attachment: MailAttachment | null;
}

const colLetter = (index: number): string => {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

const gstOrg = new WeakMap<Runtime, Promise<boolean>>();

/** Only GST-registered Zoho orgs have a Place of Supply to warn about; asked once per runtime. */
function orgUsesGst(rt: Runtime): Promise<boolean> {
  let known = gstOrg.get(rt);
  if (!known) {
    known = rt.zoho
      .get<{ organization?: { is_registered_for_gst?: boolean } }>(`/organizations/${rt.zohoConfig.organizationId}`)
      .then((r) => r.organization?.is_registered_for_gst === true)
      .catch(() => false);
    gstOrg.set(rt, known);
  }
  return known;
}

async function sendOnce(
  rt: Runtime,
  enquiryId: number,
  kind: NotificationKind,
  send: () => Promise<unknown>,
): Promise<void> {
  if (rt.repo.hasNotification(enquiryId, kind)) return;
  await send();
  rt.repo.markNotification(enquiryId, kind);
}

// --- one enquiry (one email x one attachment) ------------------------------------------------------

async function processEnquiry(rt: Runtime, id: number, unit: Unit, enquiry: EnquiryRef, referenceSeed: string): Promise<UnitResult> {
  const { repo, config } = rt;
  const { mail, attachment } = unit;
  const attachmentName = attachment?.filename ?? null;

  // No model call yet: mail that cannot become a quote (no Excel, unreadable, no rows) must cost nothing.
  // The free heuristics are enough for the "more information needed" email.
  enquiry.meta = heuristicMeta(mail);

  const needsInfo = async (reasons: string[], skipped: ParseResult['skipped'] = []): Promise<UnitResult> => {
    await sendOnce(rt, id, 'A_ADDITIONAL_INFO', () =>
      rt.notifier.additionalInfoRequired({ enquiry, reasons, skipped, quote: null }),
    );
    repo.finish(id, 'NEEDS_INFO', reasons.join(' | '));
    logger.warn('NEEDS_INFO', { enquiryId: id, reasons });
    return { attachment: attachmentName, outcome: 'needs_info', enquiryId: id };
  };

  // 1. The attachment
  if (!attachment) {
    const reasons = ['No Excel (.xlsx) attachment was found on the email.'];
    if (mail.unsupportedAttachments.length > 0) {
      reasons.push(`These files cannot be read; please resend as .xlsx: ${mail.unsupportedAttachments.join(', ')}.`);
    }
    return needsInfo(reasons);
  }

  // 2. Excel -> clean lines (rules first, LLM only to place columns, all numbers read by code)
  let parsed: ParseResult;
  try {
    parsed = await parseRfq(attachment.content, {
      maxRows: config.limits.maxExcelRows,
      resolveColumns: rt.resolveColumns,
    });
  } catch (err) {
    if (err instanceof ExcelParseError) return needsInfo([err.message]);
    throw err;
  }
  const unreadable = parsed.skipped.filter((s) => s.category === 'unparseable');
  const dropped = parsed.skipped.filter((s) => s.category === 'dropped');
  repo.audit(
    id,
    'EXCEL_PARSED',
    `${parsed.lines.length} lines, ${unreadable.length} unreadable, ${dropped.length} ignored, columns by ${parsed.mappingSource}`,
  );
  if (parsed.lines.length === 0) {
    return needsInfo(
      ['No item rows with a readable, positive quantity were found in the spreadsheet.'],
      parsed.skipped.filter((s) => s.category === 'unparseable'),
    );
  }

  // 3. Only now, for mail that will actually be quoted or halted on its customer, read the email text with the model.
  enquiry.meta = await extractEmailMetadata(rt.llm, mail);
  repo.audit(id, 'EMAIL_METADATA', `${enquiry.meta.source}${enquiry.meta.flags.length ? ` flags=${enquiry.meta.flags.join(',')}` : ''}`);
  repo.setEmailInfo(id, { companyInEmail: enquiry.meta.companyName, emailDate: mail.date });

  // 4. Customer (never auto-created)
  const lookup = await resolveCustomer(
    rt.zoho,
    { senderEmail: mail.from.address, companyName: enquiry.meta.companyName },
    config.publicDomains,
    rt.customers,
  );
  if (lookup.resolution.status !== 'found') {
    const ambiguous = lookup.resolution.status === 'ambiguous';
    await sendOnce(rt, id, 'CUSTOMER_NOT_FOUND', () =>
      rt.notifier.customerNotFound({
        enquiry,
        resolution: ambiguous ? 'ambiguous' : 'not_found',
        candidates: lookup.resolution.status === 'ambiguous' ? lookup.resolution.candidates : [],
        tried: lookup.tried,
      }),
    );
    // For a customer who simply is not there yet: read their details from the signature once, so a person can review
    // and add them with one click. (Not for a clash between customers that already exist.)
    if (!ambiguous && !repo.get(id)?.customerDraft) repo.setCustomerDraft(id, await extractCustomerDraft(rt.llm, mail, enquiry.meta));
    const status = ambiguous ? 'HALTED_CUSTOMER_AMBIGUOUS' : 'HALTED_CUSTOMER_NOT_FOUND';
    repo.finish(id, status, lookup.tried.join(' | '));
    logger.warn(status, { enquiryId: id, sender: mail.from.address, tried: lookup.tried });
    return { attachment: attachmentName, outcome: 'halted_customer', enquiryId: id };
  }
  const { contact, tier, confidence } = lookup.resolution;
  repo.audit(id, 'CUSTOMER_RESOLVED', `${tier}:${contact.contact_id}:${contact.company_name || contact.contact_name}`);

  // 5. Items: SKU, then exact normalized name. Nothing is dropped.
  await rt.catalog.ensureLoaded();
  const lines: MatchedLine[] = parsed.lines.map((line) => ({ line, match: rt.catalog.match(line) }));

  // 6. Draft quotation (idempotent: an earlier attempt's estimate is found by its reference number)
  const reference = `AIQ-${referenceSeed.slice(0, 16)}`;
  const meta = enquiry.meta;
  const notes = [
    meta.deliveryAddress ? `Ship to: ${meta.deliveryAddress}` : '',
    meta.deliveryTimeline ? `Delivery: ${meta.deliveryTimeline}` : '',
    meta.specialNotes ? `Notes: ${meta.specialNotes}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const payload = buildEstimatePayload({
    customer: contact,
    lines,
    reference,
    notes: notes ? `Enquiry (verify before sending): ${notes}`.slice(0, 500) : null,
    validityDays: config.quote.validityDays,
    timezone: config.timezone,
    sendItemRate: config.quote.sendItemRate,
    now: rt.clock(),
  });
  // Always look first. A retry may find the estimate a failed attempt left behind, and so can a run against a fresh or
  // restored database: duplicate-proofing must not depend on the local database surviving.
  let estimate = await findEstimateByReference(rt.zoho, reference);
  if (estimate) {
    logger.warn('Reusing the estimate created by an earlier attempt', { enquiryId: id, estimate: estimate.estimateNumber });
  } else {
    estimate = await createDraftEstimate(rt.zoho, payload);
  }

  // 7. Which lines still need a person: unlinked, ambiguous, or priced at 0.00 by Zoho
  const stored = estimate.lineItems.length === lines.length ? estimate.lineItems : null;
  if (!stored) logger.warn('Zoho returned a different number of lines than were sent', { enquiryId: id });
  const unmatched: UnmatchedLineInfo[] = [];
  lines.forEach(({ line, match }, i) => {
    const base = { rowNumber: line.rowNumber, sku: line.sku, description: line.description, quantity: line.quantity };
    if (match.status === 'unmatched') {
      unmatched.push({ ...base, reason: match.reason === 'AMBIGUOUS' ? 'More than one Zoho item matches' : 'No matching item in Zoho Books' });
    } else if (stored?.[i] && stored[i].rate === 0) {
      unmatched.push({ ...base, reason: 'Zoho item has no price (rate 0.00)' });
    }
  });

  const quote: QuoteSummary = {
    estimateNumber: estimate.estimateNumber,
    total: estimate.total,
    currencyCode: estimate.currencyCode,
    url: quoteUrl(rt.zohoConfig, config.quote.linkPath, estimate.estimateId),
    validUntil: payload.expiryDate,
  };
  const findings = reviewFindings(parsed.lines, estimate.total, estimate.currencyCode, config.review);
  repo.recordEstimate(id, {
    customerName: contact.company_name || contact.contact_name,
    matchTier: tier,
    unreadableRows: unreadable.length,
    reviewFlags: [...new Set(findings.map((f) => f.flag))],
    customerId: contact.contact_id,
    estimateId: estimate.estimateId,
    estimateNumber: estimate.estimateNumber,
    quoteUrl: quote.url,
    totalAmount: estimate.total,
    currencyCode: estimate.currencyCode,
    lineCount: lines.length,
    matchedCount: lines.length - unmatched.length,
    unmatchedCount: unmatched.length,
  });

  // 8. Notifications (each kind at most once per enquiry, even across retries)
  if (unmatched.length > 0) {
    await sendOnce(rt, id, 'B_UNMATCHED_PRODUCTS', () =>
      rt.notifier.unmatchedProducts({ enquiry, quote, unmatched, totalLines: lines.length }),
    );
  }
  if (unreadable.length > 0) {
    await sendOnce(rt, id, 'A_ADDITIONAL_INFO', () =>
      rt.notifier.additionalInfoRequired({
        enquiry,
        reasons: [`${unreadable.length} row(s) could not be read and are NOT in the draft quotation.`],
        skipped: unreadable,
        quote,
      }),
    );
  }

  const warnings: string[] = findings.map((f) => f.message);
  if (enquiry.meta.flags.includes('instructions_to_ai')) {
    warnings.push('The email contains text addressed to an AI system (for example "ignore previous instructions"). It was ignored and no free-text notes were taken from it. Treat this sender with caution.');
  }
  if (confidence === 'probable') {
    warnings.push(`Customer was matched by ${tier.replace('_', ' ')} only. Confirm it is the right customer before sending.`);
  }
  if (!contact.place_of_contact && (await orgUsesGst(rt))) {
    warnings.push('The customer has no Place of Supply in Zoho Books, so GST may be calculated incorrectly. Set it before sending.');
  }
  if (parsed.mappingSource === 'llm') {
    const m = parsed.mapping;
    const cols = [
      m.sku !== null ? `code=${colLetter(m.sku)}` : '',
      m.description !== null ? `description=${colLetter(m.description)}` : '',
      m.quantity !== null ? `quantity=${colLetter(m.quantity)}` : '',
      m.uom !== null ? `unit=${colLetter(m.uom)}` : '',
    ].filter(Boolean);
    warnings.push(`The spreadsheet columns were identified by AI (${cols.join(', ')}). Spot-check quantities against the file.`);
  }
  const unknownUnits = [...new Set(parsed.lines.filter((l) => l.uomRaw && !l.uom).map((l) => l.uomRaw as string))];
  if (unknownUnits.length > 0) {
    warnings.push(`Unit(s) not recognised as a Zoho standard unit: ${unknownUnits.join(', ')}. Quantities were kept as written.`);
  }
  for (const { line, match } of lines) {
    if (match.status !== 'matched' || !line.uom) continue;
    const itemUnit = normalizeUom(match.item.unit);
    if (itemUnit && itemUnit !== line.uom && warnings.length < 12) {
      warnings.push(`Row ${line.rowNumber}: enquiry unit "${line.uomRaw}" differs from the Zoho item unit "${match.item.unit}".`);
    }
  }

  await sendOnce(rt, id, 'C_DRAFT_CREATED', () =>
    rt.notifier.draftCreated({
      enquiry,
      quote,
      customerName: contact.company_name || contact.contact_name,
      matchedBy: tier,
      confidence,
      counts: {
        lines: lines.length,
        matched: lines.length - unmatched.length,
        unmatched: unmatched.length,
        unreadableRows: unreadable.length,
        droppedRows: dropped.length,
      },
      warnings,
    }),
  );

  const status = unmatched.length > 0 ? 'QUOTE_CREATED_WITH_EXCEPTIONS' : 'QUOTE_CREATED';
  repo.finish(id, status, `${quote.estimateNumber} ${quote.url}`);
  logger.info(status, { enquiryId: id, estimate: quote.estimateNumber, lines: lines.length, unmatched: unmatched.length });
  return {
    attachment: attachmentName,
    outcome: unmatched.length > 0 ? 'quote_created_with_exceptions' : 'quote_created',
    enquiryId: id,
    quote,
  };
}

/** Tell the team an enquiry has failed for good. Returns false (and logs) if the alert itself could not be sent. */
async function alertFailure(rt: Runtime, enquiry: EnquiryRef, error: string, attempts: number): Promise<boolean> {
  try {
    await sendOnce(rt, enquiry.enquiryId, 'PROCESSING_FAILED', () =>
      rt.notifier.processingFailed({ enquiry, error, attempts }),
    );
    return true;
  } catch (notifyErr) {
    logger.error('Could not send the failure alert; will retry next poll', {
      enquiryId: enquiry.enquiryId,
      error: errorMessage(notifyErr),
    });
    return false;
  }
}

interface UnitOptions {
  /** Failures will not fix themselves (e.g. an unreadable email): alert after the first attempt. */
  permanent?: boolean;
  /** A held email is being processed again because its customer now exists. */
  reopen?: boolean;
}

/** Claim in the database first, then do the work. Any thrown error becomes FAILED (retried on later polls). */
async function runUnit(rt: Runtime, unit: Unit, keys: { messageKey: string; contentHash: string }, options: UnitOptions = {}): Promise<UnitResult> {
  const { mail, attachment } = unit;
  const attachmentName = attachment?.filename ?? null;
  const claim = rt.repo.claim({
    messageKey: keys.messageKey,
    contentHash: keys.contentHash,
    messageId: mail.messageId,
    senderEmail: mail.from.address,
    subject: mail.subject,
    attachmentName,
    ...(options.reopen ? { reopen: true } : {}),
  });

  const enquiryFor = (enquiryId: number): EnquiryRef => ({
    enquiryId,
    senderEmail: mail.from.address,
    senderName: mail.from.name,
    subject: mail.subject,
    attachmentName,
    meta: null,
  });

  const alertExhausted = async (id: number, error: string, attempts: number): Promise<UnitResult> => ({
    attachment: attachmentName,
    outcome: (await alertFailure(rt, enquiryFor(id), error, attempts)) ? 'failed_exhausted' : 'failed_will_retry',
    enquiryId: id,
  });

  switch (claim.outcome) {
    case 'duplicate_message':
      logger.info('Already handled; skipping', { messageId: mail.messageId, status: claim.existing.status });
      return { attachment: attachmentName, outcome: 'duplicate', enquiryId: claim.existing.id };
    case 'duplicate_content':
      logger.info('Identical enquiry already quoted within the dedupe window; skipping', {
        messageId: mail.messageId,
        original: claim.existing.id,
        estimate: claim.existing.estimateNumber,
      });
      rt.repo.audit(claim.existing.id, 'DUPLICATE_ENQUIRY_IGNORED', `${mail.messageId} from ${mail.from.address}`);
      return { attachment: attachmentName, outcome: 'duplicate', enquiryId: claim.existing.id };
    case 'in_progress':
      return { attachment: attachmentName, outcome: 'in_progress', enquiryId: claim.existing.id };
    case 'attempts_exhausted':
      return alertExhausted(claim.existing.id, claim.existing.error ?? 'unknown error', claim.existing.attempts);
    case 'claimed':
      break;
  }

  const id = claim.id;
  try {
    // Reference is derived from the message key, so every retry of this delivery finds the same Zoho estimate.
    return await processEnquiry(rt, id, unit, enquiryFor(id), keys.messageKey);
  } catch (err) {
    const message = errorMessage(err);
    const { attempts, exhausted } = rt.repo.fail(id, message);
    logger.error('Enquiry failed', { enquiryId: id, attempts, error: message });
    if (exhausted || options.permanent) return alertExhausted(id, message, attempts);
    return { attachment: attachmentName, outcome: 'failed_will_retry', enquiryId: id };
  }
}

// --- one email -------------------------------------------------------------------------------------

/** Process one raw RFC 822 message (every Excel attachment is its own enquiry). Never throws. */
export async function processRawMessage(rt: Runtime, source: Buffer, options: { reopen?: boolean } = {}): Promise<MessageResult> {
  let mail: InboundMail;
  try {
    mail = await parseRawEmail(source, { maxAttachmentBytes: rt.config.limits.maxAttachmentBytes });
  } catch (err) {
    // Not even parseable: record it once, alert once, and stop retrying.
    logger.error('Email could not be parsed', { error: errorMessage(err) });
    const digest = sha256Hex('unparseable', source);
    const messageId = `<unparseable:${digest.slice(0, 16)}>`;
    const claim = rt.repo.claim({
      messageKey: digest,
      contentHash: digest,
      messageId,
      senderEmail: 'unknown@invalid',
      subject: '(unreadable email)',
      attachmentName: null,
    });
    if (claim.outcome !== 'claimed') {
      const settled = claim.outcome === 'duplicate_message' || claim.outcome === 'attempts_exhausted';
      return { handled: settled, messageId, results: [{ attachment: null, outcome: settled ? 'duplicate' : 'in_progress' }] };
    }
    const message = `Unparseable email: ${errorMessage(err)}`;
    const { attempts } = rt.repo.fail(claim.id, message);
    const stub: EnquiryRef = {
      enquiryId: claim.id,
      senderEmail: 'unknown@invalid',
      senderName: '',
      subject: '(unreadable email)',
      attachmentName: null,
      meta: null,
    };
    const alerted = await alertFailure(rt, stub, message, attempts);
    const outcome: UnitOutcome = alerted ? 'failed_exhausted' : 'failed_will_retry';
    return { handled: alerted, messageId, results: [{ attachment: null, outcome, enquiryId: claim.id }] };
  }

  // Never treat automatic mail as an enquiry. Without this, an alert that lands in the monitored mailbox would be read
  // as a new enquiry, trigger another alert, and so on every poll.
  const own = (rt.config.notify.from.match(/<([^>]+)>/)?.[1] ?? rt.config.notify.from).trim().toLowerCase();
  // Second line of defence if a mail server strips the markers: our own address, nothing attached, and one of our alert subjects.
  const ownAlert = mail.excelAttachments.length === 0 && mail.from.address === own && isOwnAlertSubject(mail.subject);
  const automatic = mail.automatic ?? (ownAlert ? "an alert sent from this assistant's own address" : null);
  if (automatic) {
    logger.info('Skipped an automatic email (it is flagged as read and not treated as an enquiry)', { from: mail.from.address, subject: mail.subject.slice(0, 80), reason: automatic });
    return { handled: true, messageId: mail.messageId, results: [{ attachment: null, outcome: 'ignored_automatic' }] };
  }

  const units: Unit[] =
    mail.excelAttachments.length > 0
      ? mail.excelAttachments.map((attachment) => ({ mail, attachment }))
      : [{ mail, attachment: null }];

  const results: UnitResult[] = [];
  for (const unit of units) {
    const bytes = unit.attachment?.content ?? Buffer.from(mail.latestText, 'utf8');
    const keys = computeKeys(bytes, mail.from.address, mail.messageId);
    results.push(await runUnit(rt, unit, keys, options.reopen ? { reopen: true } : {}));
  }

  // A customer who is not in Zoho Books yet: keep the email, so the quote is made by itself once they are added and
  // nobody has to ask the sender to resend. The mailbox copy is still marked read. Deleted when the quote is made,
  // when the hold runs out, or with the enquiry.
  const hold = rt.config.hold;
  if (hold.days > 0) {
    for (const r of results) {
      if (r.outcome !== 'halted_customer' || r.enquiryId === undefined) continue;
      const until = new Date(rt.clock().getTime() + hold.days * 86_400_000).toISOString();
      if (rt.repo.holdMail(r.enquiryId, source, until, hold.maxEmails)) logger.info('Email kept until the customer is added', { enquiryId: r.enquiryId, days: hold.days });
      else logger.warn('Too many held emails; this one is not kept (ask the sender to resend after adding the customer)', { enquiryId: r.enquiryId, limit: hold.maxEmails });
    }
  }
  return { handled: results.every((r) => FINAL.has(r.outcome)), messageId: mail.messageId, results };
}

// --- emails waiting for a new customer ---------------------------------------------------------------------

/**
 * Held emails (customer not found, kept for a few days): each time through, drop the ones whose time is up, and for the
 * rest check, cheaply, whether the customer exists in Zoho Books now. Only when it does is the whole email processed
 * again, which creates the draft quote and sends the usual alert. The sender never has to resend anything.
 */
export async function retryHeldEnquiries(rt: Runtime): Promise<{ checked: number; resolved: number; expired: number }> {
  const out = { checked: 0, resolved: 0, expired: 0 };
  out.expired = rt.repo.expireHeld();
  const due = rt.repo.heldDue(rt.config.hold.checkMinutes, 25);
  // Look at Zoho's current customers (at most once a minute) so a customer added or a clash cleared is seen straight away,
  // not after the cached list expires.
  if (due.length > 0 && rt.customers.canRefresh()) await rt.customers.reload();
  for (const id of due) {
    const enquiry = rt.repo.get(id);
    const raw = rt.repo.heldRaw(id);
    if (!enquiry || !raw) continue;
    rt.repo.touchHeld(id);
    out.checked++;
    const lookup = await resolveCustomer(rt.zoho, { senderEmail: enquiry.senderEmail, companyName: enquiry.companyInEmail }, rt.config.publicDomains, rt.customers);
    if (lookup.resolution.status !== 'found') continue;
    const result = (await processRawMessage(rt, raw, { reopen: true })).results.find((r) => r.enquiryId === id);
    if (result?.outcome === 'quote_created' || result?.outcome === 'quote_created_with_exceptions') {
      rt.repo.releaseHeld(id);
      out.resolved++;
      logger.info('Held email turned into a quote now that the customer exists', { enquiryId: id, outcome: result.outcome });
    }
  }
  if (out.checked + out.expired > 0) logger.info('Held emails checked', out);
  return out;
}

// --- one polling cycle -----------------------------------------------------------------------------

export interface CycleSummary {
  fetched: number;
  handled: number;
  left_unread: number;
  quotes: number;
  quotesWithExceptions: number;
  needsInfo: number;
  haltedCustomer: number;
  duplicates: number;
  failed: number;
}

/**
 * Fetch unread mail, process each message to completion, and only then flag the handled ones \Seen
 * (and move them, if configured). Anything still in progress or failing is left unread for the next poll.
 */
export async function runWorkflowCycle(rt: Runtime): Promise<CycleSummary> {
  if (!rt.mailbox) throw new ConfigError('The mailbox is not configured: set IMAP_HOST, IMAP_USER and IMAP_PASSWORD.');

  const batch = await rt.mailbox.fetchUnseen();
  const summary: CycleSummary = {
    fetched: batch.messages.length,
    handled: 0,
    left_unread: 0,
    quotes: 0,
    quotesWithExceptions: 0,
    needsInfo: 0,
    haltedCustomer: 0,
    duplicates: 0,
    failed: 0,
  };
  const handledUids: number[] = [];

  for (const message of batch.messages) {
    try {
      const outcome = await processRawMessage(rt, message.source);
      for (const r of outcome.results) {
        if (r.outcome === 'quote_created') summary.quotes++;
        else if (r.outcome === 'quote_created_with_exceptions') summary.quotesWithExceptions++;
        else if (r.outcome === 'needs_info') summary.needsInfo++;
        else if (r.outcome === 'halted_customer') summary.haltedCustomer++;
        else if (r.outcome === 'duplicate') summary.duplicates++;
        else if (r.outcome === 'failed_will_retry' || r.outcome === 'failed_exhausted') summary.failed++;
      }
      if (outcome.handled) handledUids.push(message.uid);
      else summary.left_unread++;
    } catch (err) {
      summary.left_unread++;
      logger.error('Unexpected error; message left unread', { uid: message.uid, error: errorMessage(err) });
    }
  }

  await rt.mailbox.markHandled(batch.uidValidity, handledUids);
  summary.handled = handledUids.length;
  if (rt.llm.isEnabled() && batch.messages.length > 0) {
    const st = rt.llm.stats();
    logger.info('Model usage this cycle', {
      calls: st.total.calls,
      tokensIn: st.total.inputTokens,
      tokensOut: st.total.outputTokens,
      estimatedUsd: Number(st.total.estimatedUsd.toFixed(5)),
      byTask: Object.fromEntries(Object.entries(st.byTask).map(([k, v]) => [k, v.calls])),
    });
    rt.llm.resetStats();
  }
  try {
    await retryHeldEnquiries(rt);
  } catch (err) {
    logger.error('Checking held emails failed; it will be tried again next cycle', { error: errorMessage(err) });
  }
  return summary;
}

/** `npm run process-now`: one cycle, then exit. Never throws; sets a non-zero exit code on failure. */
export async function runWorkflowOnce(): Promise<CycleSummary | null> {
  let rt: Runtime | undefined;
  try {
    const config = getConfig();
    setLogLevel(config.logLevel);
    rt = createRuntime(config);
    const summary = await runWorkflowCycle(rt);
    logger.info('Run finished', { ...summary });
    return summary;
  } catch (err) {
    logger.error('Workflow run failed', { error: errorMessage(err) });
    process.exitCode = 1;
    return null;
  } finally {
    rt?.close();
  }
}
