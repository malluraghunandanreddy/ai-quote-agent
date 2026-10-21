import type { Db } from './index';
import type { CustomerDraft } from '../llm/customerExtractor';
import type { EnquiryStatus, NotificationKind } from '../types';

export interface Enquiry {
  id: number;
  messageKey: string;
  contentHash: string;
  messageId: string;
  senderEmail: string;
  subject: string;
  attachmentName: string | null;
  status: EnquiryStatus;
  attempts: number;
  zohoCustomerId: string | null;
  zohoEstimateId: string | null;
  estimateNumber: string | null;
  quoteUrl: string | null;
  totalAmount: number | null;
  currencyCode: string | null;
  lineCount: number | null;
  matchedCount: number | null;
  unmatchedCount: number | null;
  error: string | null;
  customerName: string | null;
  matchTier: string | null;
  companyInEmail: string | null;
  emailDate: string | null;
  unreadableRows: number | null;
  reviewFlags: string[];
  /** Set while the email is being kept for a customer who is not in Zoho Books yet. */
  holdUntil: string | null;
  /** Customer details read from the email, to pre-fill the "add customer" form; null once the customer is added. */
  customerDraft: CustomerDraft | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimInput {
  messageKey: string;
  contentHash: string;
  messageId: string;
  senderEmail: string;
  subject: string;
  attachmentName: string | null;
  /** Process a held email again (its customer has appeared). Only affects enquiries halted on their customer. */
  reopen?: boolean;
}

export type ClaimResult =
  | { outcome: 'claimed'; id: number; attempt: number }
  /** The very same delivery was already handled. */
  | { outcome: 'duplicate_message'; existing: Enquiry }
  /** An identical enquiry (same Excel bytes, same sender) was already quoted inside the dedupe window. */
  | { outcome: 'duplicate_content'; existing: Enquiry }
  /** Another run is working on it right now. */
  | { outcome: 'in_progress'; existing: Enquiry }
  /** Failed too many times; a person has been (or will be) alerted. */
  | { outcome: 'attempts_exhausted'; existing: Enquiry };

export interface EstimateRecord {
  customerId: string;
  estimateId: string;
  estimateNumber: string;
  quoteUrl: string;
  totalAmount: number;
  currencyCode: string;
  lineCount: number;
  matchedCount: number;
  unmatchedCount: number;
  customerName?: string;
  matchTier?: string;
  unreadableRows?: number;
  /** Things Sales should double-check (large quantity, large total ...). */
  reviewFlags?: string[];
}

export interface RepositoryOptions {
  dedupeWindowHours: number;
  maxAttempts: number;
  staleProcessingMinutes: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

interface EnquiryRow {
  id: number;
  message_key: string;
  content_hash: string;
  message_id: string;
  sender_email: string;
  subject: string;
  attachment_name: string | null;
  status: EnquiryStatus;
  attempts: number;
  zoho_customer_id: string | null;
  zoho_estimate_id: string | null;
  estimate_number: string | null;
  quote_url: string | null;
  total_amount: number | null;
  currency_code: string | null;
  line_count: number | null;
  matched_count: number | null;
  unmatched_count: number | null;
  error: string | null;
  customer_name: string | null;
  match_tier: string | null;
  company_in_email: string | null;
  email_date: string | null;
  unreadable_rows: number | null;
  review_flags: string | null;
  hold_until: string | null;
  customer_draft: string | null;
  created_at: string;
  updated_at: string;
}

function parseDraft(json: string | null | undefined): CustomerDraft | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as CustomerDraft;
    return typeof d === 'object' && d !== null && typeof d.companyName === 'string' ? d : null;
  } catch {
    return null;
  }
}

function toEnquiry(r: EnquiryRow): Enquiry {
  return {
    id: r.id,
    messageKey: r.message_key,
    contentHash: r.content_hash,
    messageId: r.message_id,
    senderEmail: r.sender_email,
    subject: r.subject,
    attachmentName: r.attachment_name,
    status: r.status,
    attempts: r.attempts,
    zohoCustomerId: r.zoho_customer_id,
    zohoEstimateId: r.zoho_estimate_id,
    estimateNumber: r.estimate_number,
    quoteUrl: r.quote_url,
    totalAmount: r.total_amount,
    currencyCode: r.currency_code,
    lineCount: r.line_count,
    matchedCount: r.matched_count,
    unmatchedCount: r.unmatched_count,
    error: r.error,
    customerName: r.customer_name,
    matchTier: r.match_tier,
    companyInEmail: r.company_in_email,
    emailDate: r.email_date,
    unreadableRows: r.unreadable_rows,
    reviewFlags: r.review_flags ? r.review_flags.split(',').filter(Boolean) : [],
    holdUntil: r.hold_until ?? null,
    customerDraft: parseDraft(r.customer_draft),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Repository {
  private readonly now: () => Date;
  private readonly claimTx: (input: ClaimInput) => ClaimResult;

  constructor(
    private readonly db: Db,
    private readonly opts: RepositoryOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    // BEGIN IMMEDIATE: the read-check-insert below is atomic even with two processes on the same file.
    const tx = db.transaction((input: ClaimInput) => this.claimInTransaction(input));
    this.claimTx = (input) => tx.immediate(input);
  }

  /** The underlying database, for the stores that live beside this one (users, notes). */
  get database(): Db {
    return this.db;
  }

  /**
   * Atomically decide whether this (email, attachment) may be processed, and if so record it as PROCESSING.
   * Nothing with side effects (Zoho, email) may run before this returns `claimed`.
   */
  claim(input: ClaimInput): ClaimResult {
    return this.claimTx(input);
  }

  private claimInTransaction(input: ClaimInput): ClaimResult {
    const nowMs = this.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const staleCutoff = new Date(nowMs - this.opts.staleProcessingMinutes * 60_000).toISOString();

    const existing = this.db
      .prepare<[string], EnquiryRow>('SELECT * FROM enquiries WHERE message_key = ?')
      .get(input.messageKey);

    if (existing) {
      const enquiry = toEnquiry(existing);
      const stale = enquiry.status === 'PROCESSING' && enquiry.updatedAt < staleCutoff;
      if (enquiry.status === 'PROCESSING' && !stale) return { outcome: 'in_progress', existing: enquiry };
      if (enquiry.status === 'FAILED' || stale) {
        if (enquiry.attempts >= this.opts.maxAttempts) return { outcome: 'attempts_exhausted', existing: enquiry };
        this.db
          .prepare(
            "UPDATE enquiries SET status = 'PROCESSING', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ?",
          )
          .run(nowIso, enquiry.id);
        this.writeAudit(enquiry.id, 'RETRY', `attempt ${enquiry.attempts + 1}`);
        return { outcome: 'claimed', id: enquiry.id, attempt: enquiry.attempts + 1 };
      }
      if (input.reopen && (enquiry.status === 'HALTED_CUSTOMER_NOT_FOUND' || enquiry.status === 'HALTED_CUSTOMER_AMBIGUOUS')) {
        this.db.prepare("UPDATE enquiries SET status = 'PROCESSING', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ?").run(nowIso, enquiry.id);
        this.writeAudit(enquiry.id, 'RETRY', 'the customer is now in Zoho Books: processing the held email again');
        return { outcome: 'claimed', id: enquiry.id, attempt: enquiry.attempts + 1 };
      }
      return { outcome: 'duplicate_message', existing: enquiry };
    }

    // Same Excel from the same sender already quoted (or being quoted) inside the window?
    // HALTED / NEEDS_INFO / FAILED rows do not block: fixing the cause and re-sending must work.
    const windowCutoff = new Date(nowMs - this.opts.dedupeWindowHours * 3_600_000).toISOString();
    const duplicate = this.db
      .prepare<[string, string, string], EnquiryRow>(
        `SELECT * FROM enquiries
          WHERE content_hash = ? AND created_at >= ?
            AND (status IN ('QUOTE_CREATED', 'QUOTE_CREATED_WITH_EXCEPTIONS')
                 OR (status = 'PROCESSING' AND updated_at >= ?))
          ORDER BY id LIMIT 1`,
      )
      .get(input.contentHash, windowCutoff, staleCutoff);
    if (duplicate) return { outcome: 'duplicate_content', existing: toEnquiry(duplicate) };

    const info = this.db
      .prepare(
        `INSERT INTO enquiries
           (message_key, content_hash, message_id, sender_email, subject, attachment_name, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', 1, ?, ?)`,
      )
      .run(
        input.messageKey,
        input.contentHash,
        input.messageId,
        input.senderEmail,
        input.subject.slice(0, 500),
        input.attachmentName,
        nowIso,
        nowIso,
      );
    const id = Number(info.lastInsertRowid);
    this.writeAudit(id, 'CLAIMED', input.attachmentName ?? '(no attachment)');
    return { outcome: 'claimed', id, attempt: 1 };
  }

  get(id: number): Enquiry | undefined {
    const row = this.db.prepare<[number], EnquiryRow>('SELECT * FROM enquiries WHERE id = ?').get(id);
    return row ? toEnquiry(row) : undefined;
  }

  /** Persist the Zoho result immediately, before any notification, so a crash never loses the estimate id. */
  recordEstimate(id: number, rec: EstimateRecord): void {
    this.db
      .prepare(
        `UPDATE enquiries SET zoho_customer_id = ?, zoho_estimate_id = ?, estimate_number = ?, quote_url = ?,
           total_amount = ?, currency_code = ?, line_count = ?, matched_count = ?, unmatched_count = ?,
           customer_name = ?, match_tier = ?, unreadable_rows = ?, review_flags = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        rec.customerId,
        rec.estimateId,
        rec.estimateNumber,
        rec.quoteUrl,
        rec.totalAmount,
        rec.currencyCode,
        rec.lineCount,
        rec.matchedCount,
        rec.unmatchedCount,
        rec.customerName ?? null,
        rec.matchTier ?? null,
        rec.unreadableRows ?? null,
        (rec.reviewFlags ?? []).join(',') || null,
        this.now().toISOString(),
        id,
      );
    this.writeAudit(id, 'ESTIMATE_RECORDED', `${rec.estimateNumber} (${rec.estimateId})`);
  }

  finish(id: number, status: Exclude<EnquiryStatus, 'PROCESSING' | 'FAILED'>, detail?: string): void {
    this.db
      .prepare('UPDATE enquiries SET status = ?, error = NULL, updated_at = ? WHERE id = ?')
      .run(status, this.now().toISOString(), id);
    this.writeAudit(id, status, detail ?? null);
  }

  /** Record a processing failure. `exhausted` = no further automatic retries. */
  fail(id: number, message: string): { attempts: number; exhausted: boolean } {
    this.db
      .prepare("UPDATE enquiries SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?")
      .run(message.slice(0, 2000), this.now().toISOString(), id);
    this.writeAudit(id, 'FAILED', message.slice(0, 500));
    const attempts = this.get(id)?.attempts ?? 1;
    return { attempts, exhausted: attempts >= this.opts.maxAttempts };
  }

  hasNotification(id: number, kind: NotificationKind): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM notifications WHERE enquiry_id = ? AND kind = ?').get(id, kind),
    );
  }

  markNotification(id: number, kind: NotificationKind): void {
    this.db
      .prepare('INSERT OR IGNORE INTO notifications (enquiry_id, kind, sent_at) VALUES (?, ?, ?)')
      .run(id, kind, this.now().toISOString());
    this.writeAudit(id, `NOTIFIED_${kind}`, null);
  }

  /** What was read from the email itself (no body text is stored). */
  setEmailInfo(id: number, info: { companyInEmail?: string | null; emailDate?: Date | null; customerName?: string | null; matchTier?: string | null }): void {
    this.db
      .prepare(
        `UPDATE enquiries SET company_in_email = COALESCE(?, company_in_email), email_date = COALESCE(?, email_date),
           customer_name = COALESCE(?, customer_name), match_tier = COALESCE(?, match_tier), updated_at = ? WHERE id = ?`,
      )
      .run(
        info.companyInEmail ?? null,
        info.emailDate && info.emailDate.getTime() > 0 ? info.emailDate.toISOString() : null,
        info.customerName ?? null,
        info.matchTier ?? null,
        this.now().toISOString(),
        id,
      );
  }

  // --- service state (last poll, last backup, session key ...) -----------------------------------

  getMeta(key: string): string | undefined {
    return this.db.prepare<[string], { value: string }>('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, this.now().toISOString());
  }

  // --- model usage ---------------------------------------------------------------------------------

  addLlmUsage(day: string, task: string, calls: number, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage_daily (day, task, calls, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, task) DO UPDATE SET calls = calls + excluded.calls,
           input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(day, task, calls, inputTokens, outputTokens);
  }

  llmUsageSince(day: string): Array<{ day: string; task: string; calls: number; inputTokens: number; outputTokens: number }> {
    return this.db
      .prepare<[string], { day: string; task: string; calls: number; input_tokens: number; output_tokens: number }>(
        'SELECT day, task, calls, input_tokens, output_tokens FROM llm_usage_daily WHERE day >= ? ORDER BY day, task',
      )
      .all(day)
      .map((r) => ({ day: r.day, task: r.task, calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens }));
  }

  // --- reading for the dashboard and the daily summary ------------------------------------------------

  /** Everything received since `iso` (newest first). Volumes are hundreds a month, so this stays small. */
  enquiriesSince(iso: string, limit = 20_000): Enquiry[] {
    return this.db
      .prepare<[string, number], EnquiryRow>('SELECT * FROM enquiries WHERE created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(iso, limit)
      .map(toEnquiry);
  }

  listEnquiries(opts: { statuses?: EnquiryStatus[]; flaggedOnly?: boolean; limit: number; offset: number }): { rows: Enquiry[]; total: number } {
    const statuses = opts.statuses && opts.statuses.length > 0 ? opts.statuses : null;
    const conditions = [...(statuses ? [`status IN (${statuses.map(() => '?').join(',')})`] : []), ...(opts.flaggedOnly ? ["review_flags IS NOT NULL AND review_flags <> ''"] : [])];
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const args: unknown[] = statuses ? [...statuses] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM enquiries ${where}`).get(...args) as { n: number }).n;
    const rows = (this.db
      .prepare(`SELECT * FROM enquiries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, opts.limit, opts.offset) as EnquiryRow[]).map(toEnquiry);
    return { rows, total };
  }

  notificationsFor(id: number): Array<{ kind: string; sentAt: string }> {
    return this.db
      .prepare<[number], { kind: string; sent_at: string }>('SELECT kind, sent_at FROM notifications WHERE enquiry_id = ? ORDER BY sent_at')
      .all(id)
      .map((r) => ({ kind: r.kind, sentAt: r.sent_at }));
  }

  // --- retention -----------------------------------------------------------------------------------

  /** Delete enquiries (and their audit trail and notification records) older than the cutoff. Never touches work in progress. */
  // --- emails kept for a customer who is not in Zoho Books yet ---------------------------------------------------

  /** Keep the raw email so the quote can be made later. Returns false (and keeps nothing) when the limit is reached. */
  holdMail(enquiryId: number, raw: Buffer, untilIso: string, maxHeld: number): boolean {
    const nowIso = this.now().toISOString();
    return this.db.transaction(() => {
      const others = (this.db.prepare('SELECT COUNT(*) AS n FROM held_mail WHERE enquiry_id <> ?').get(enquiryId) as { n: number }).n;
      if (others >= maxHeld) return false;
      this.db
        .prepare('INSERT INTO held_mail (enquiry_id, raw, held_at, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (enquiry_id) DO UPDATE SET raw = excluded.raw')
        .run(enquiryId, raw, nowIso, nowIso);
      // A retry that halts again must not push the deadline out.
      const had = (this.db.prepare('SELECT hold_until FROM enquiries WHERE id = ?').get(enquiryId) as { hold_until: string | null } | undefined)?.hold_until;
      if (!had) {
        this.db.prepare('UPDATE enquiries SET hold_until = ? WHERE id = ?').run(untilIso, enquiryId);
        this.writeAudit(enquiryId, 'HELD', 'kept so the quote can be made automatically once the customer is added in Zoho Books');
      }
      return true;
    }).immediate();
  }

  setCustomerDraft(enquiryId: number, draft: CustomerDraft): void {
    this.db.prepare('UPDATE enquiries SET customer_draft = ? WHERE id = ?').run(JSON.stringify(draft), enquiryId);
  }

  /** The customer was added: the details are no longer needed. */
  clearCustomerDraft(enquiryId: number): void {
    this.db.prepare('UPDATE enquiries SET customer_draft = NULL WHERE id = ?').run(enquiryId);
  }

  /** Check this held email on the next cycle instead of waiting out the usual interval. */
  makeHeldDue(enquiryId: number): void {
    this.db.prepare("UPDATE held_mail SET checked_at = '1970-01-01T00:00:00.000Z' WHERE enquiry_id = ?").run(enquiryId);
  }

  /** Held enquiries that have not been checked for `minutes`, oldest first. */
  heldDue(minutes: number, limit: number): number[] {
    const cutoff = new Date(this.now().getTime() - minutes * 60_000).toISOString();
    const rows = this.db.prepare('SELECT enquiry_id FROM held_mail WHERE checked_at <= ? ORDER BY held_at, enquiry_id LIMIT ?').all(cutoff, limit) as Array<{ enquiry_id: number }>;
    return rows.map((r) => r.enquiry_id);
  }

  heldRaw(enquiryId: number): Buffer | undefined {
    return (this.db.prepare('SELECT raw FROM held_mail WHERE enquiry_id = ?').get(enquiryId) as { raw: Buffer } | undefined)?.raw;
  }

  heldCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM held_mail').get() as { n: number }).n;
  }

  touchHeld(enquiryId: number): void {
    this.db.prepare('UPDATE held_mail SET checked_at = ? WHERE enquiry_id = ?').run(this.now().toISOString(), enquiryId);
  }

  /** The email is no longer needed (the quote was made, or the time is up): delete the copy and the contact details read from it. */
  releaseHeld(enquiryId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM held_mail WHERE enquiry_id = ?').run(enquiryId);
      this.db.prepare('UPDATE enquiries SET hold_until = NULL, customer_draft = NULL WHERE id = ?').run(enquiryId);
    })();
  }

  /** Delete held emails whose time is up. The enquiry itself stays and still needs a person. */
  expireHeld(): number {
    const nowIso = this.now().toISOString();
    const due = this.db.prepare('SELECT id FROM enquiries WHERE hold_until IS NOT NULL AND hold_until <= ?').all(nowIso) as Array<{ id: number }>;
    for (const { id } of due) {
      this.releaseHeld(id);
      this.writeAudit(id, 'HOLD_EXPIRED', 'the email was not kept any longer; ask the sender to resend it once the customer exists');
    }
    return due.length;
  }

  purgeOlderThan(cutoffIso: string): number {
    const tx = this.db.transaction((cutoff: string) => {
      const removed = this.db.prepare("DELETE FROM enquiries WHERE created_at < ? AND status != 'PROCESSING'").run(cutoff).changes;
      this.db.prepare('DELETE FROM audit_log WHERE at < ? AND enquiry_id IS NULL').run(cutoff);
      return removed;
    });
    return tx(cutoffIso);
  }

  audit(id: number | null, event: string, detail?: string): void {
    this.writeAudit(id, event, detail ?? null);
  }

  auditTrail(id: number): Array<{ event: string; detail: string | null; at: string }> {
    return this.db
      .prepare<[number], { event: string; detail: string | null; at: string }>(
        'SELECT event, detail, at FROM audit_log WHERE enquiry_id = ? ORDER BY id',
      )
      .all(id);
  }

  private writeAudit(id: number | null, event: string, detail: string | null): void {
    this.db
      .prepare('INSERT INTO audit_log (enquiry_id, event, detail, at) VALUES (?, ?, ?, ?)')
      .run(id, event, detail, this.now().toISOString());
  }
}
