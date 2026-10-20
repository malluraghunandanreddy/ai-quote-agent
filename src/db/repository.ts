import type { Db } from './index';
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
  created_at: string;
  updated_at: string;
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
           total_amount = ?, currency_code = ?, line_count = ?, matched_count = ?, unmatched_count = ?, updated_at = ?
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
