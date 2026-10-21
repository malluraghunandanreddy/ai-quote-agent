import type { Config } from '../config';
import type { Enquiry, Repository } from '../db/repository';
import type { Notifier } from '../email/notifier';
import { errorMessage, logger } from '../logger';
import type { CycleSummary } from '../workflow/processor';
import { calendarDate } from '../zoho/quoteService';

export interface HealthStatus {
  ok: boolean;
  /** Plain-language reason when not ok. */
  reason?: string;
  startedAt?: string;
  lastPollAt?: string;
  lastPollOkAt?: string;
  consecutiveFailures: number;
  lastError?: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Statuses a person has to act on (a quote with items to price is a draft, so it is counted separately). */
export const ATTENTION_STATUSES = ['NEEDS_INFO', 'HALTED_CUSTOMER_NOT_FOUND', 'HALTED_CUSTOMER_AMBIGUOUS', 'FAILED'] as const;
export const isAttention = (status: string): boolean => (ATTENTION_STATUSES as readonly string[]).includes(status);
export const isDraft = (status: string): boolean => status === 'QUOTE_CREATED' || status === 'QUOTE_CREATED_WITH_EXCEPTIONS';

/** Read the service state from the database (so a separate dashboard process sees the same picture). */
export function computeHealth(repo: Repository, cfg: Pick<Config, 'alerts'>, now: Date = new Date()): HealthStatus {
  const get = (k: string) => repo.getMeta(k) || undefined;
  const startedAt = get('started_at');
  const lastPollAt = get('last_poll_at');
  const lastPollOkAt = get('last_poll_ok_at');
  const consecutiveFailures = Number(get('consecutive_failures') ?? 0);
  const lastError = get('last_poll_error');
  const base = { consecutiveFailures, ...(startedAt ? { startedAt } : {}), ...(lastPollAt ? { lastPollAt } : {}), ...(lastPollOkAt ? { lastPollOkAt } : {}), ...(lastError ? { lastError } : {}) };

  if (consecutiveFailures >= cfg.alerts.failuresBeforeAlert) {
    return { ok: false, reason: `${consecutiveFailures} mailbox checks in a row failed${lastError ? `: ${lastError}` : ''}`, ...base };
  }
  const reference = lastPollOkAt ?? startedAt;
  if (reference && now.getTime() - new Date(reference).getTime() > cfg.alerts.staleMinutes * MINUTE) {
    return { ok: false, reason: `no successful mailbox check for more than ${cfg.alerts.staleMinutes} minutes`, ...base };
  }
  return { ok: true, ...base };
}

/**
 * Records every polling cycle and alerts the team by email when the service keeps failing (and again when it recovers).
 * One alert per outage, not one per failed poll. If the whole process dies this cannot speak: that is what the
 * container health check and an external uptime monitor on /healthz are for.
 */
export class HealthMonitor {
  constructor(
    private readonly repo: Repository,
    private readonly cfg: Pick<Config, 'alerts'>,
    private readonly notifier: Pick<Notifier, 'serviceAlert'>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.repo.setMeta('started_at', this.clock().toISOString());
  }

  async recordCycle(result: { ok: true; summary?: CycleSummary } | { ok: false; error: unknown }): Promise<void> {
    const now = this.clock().toISOString();
    this.repo.setMeta('last_poll_at', now);
    const wasDown = this.repo.getMeta('service_alert_open') === '1';

    if (result.ok) {
      this.repo.setMeta('last_poll_ok_at', now);
      this.repo.setMeta('consecutive_failures', '0');
      this.repo.setMeta('last_poll_error', '');
      if (result.summary) this.repo.setMeta('last_cycle', JSON.stringify(result.summary));
      if (wasDown) {
        this.repo.setMeta('service_alert_open', '0');
        await this.alert({ kind: 'recovered', detail: 'The mailbox is being checked normally again.' });
      }
      return;
    }

    const failures = Number(this.repo.getMeta('consecutive_failures') ?? 0) + 1;
    const message = errorMessage(result.error).slice(0, 300);
    this.repo.setMeta('consecutive_failures', String(failures));
    this.repo.setMeta('last_poll_error', message);
    if (failures >= this.cfg.alerts.failuresBeforeAlert && !wasDown) {
      this.repo.setMeta('service_alert_open', '1');
      await this.alert({ kind: 'down', detail: message, consecutiveFailures: failures });
    }
  }

  private async alert(ctx: { kind: 'down' | 'recovered'; detail: string; consecutiveFailures?: number }): Promise<void> {
    try {
      await this.notifier.serviceAlert(ctx);
    } catch (err) {
      logger.error('Could not send the service alert', { error: errorMessage(err) });
    }
  }
}

// --- daily summary -----------------------------------------------------------------------------------

export interface DailySummary {
  /** Calendar date in the quote timezone, e.g. 2026-10-21. */
  date: string;
  received: number;
  drafts: number;
  draftsToPrice: number;
  flaggedForReview: number;
  needAttention: Array<{ id: number; status: string; sender: string; subject: string; reason: string }>;
  timeSavedMinutes: number;
  /** Money value of that time, only when STAFF_COST_PER_HOUR is set. */
  timeSavedValue?: { amount: number; currency: string };
  llm: { calls: number; inputTokens: number; outputTokens: number; estimatedUsd: number };
  backup: { lastAt?: string; ok: boolean };
  health: HealthStatus;
  dashboardUrl?: string;
}

/** Plain-language "what to do" for an enquiry that needs a person. */
export function attentionReason(e: Enquiry): string {
  switch (e.status) {
    case 'HALTED_CUSTOMER_NOT_FOUND':
      return e.holdUntil
        ? `Customer not found in Zoho${e.companyInEmail ? ` (company in the email: ${e.companyInEmail})` : ''}. Add this customer in Zoho Books. The email is being kept, and the quote is created automatically within a few minutes of the customer being added. Nobody needs to resend it.`
        : `Customer not found in Zoho${e.companyInEmail ? ` (company in the email: ${e.companyInEmail})` : ''}. Create it, then ask the sender to resend.`;
    case 'HALTED_CUSTOMER_AMBIGUOUS':
      return e.holdUntil
        ? 'More than one Zoho customer fits this sender. Make the right one unambiguous in Zoho Books. The email is being kept, and the quote is created automatically within a few minutes. Nobody needs to resend it.'
        : 'More than one Zoho customer fits this sender. Make the right one unambiguous, then ask for a resend.';
    case 'NEEDS_INFO':
      return 'The email or Excel could not be turned into a quote. Ask the sender for a readable Excel.';
    case 'FAILED':
      return `Processing failed${e.error ? `: ${e.error.slice(0, 120)}` : ''}.`;
    default:
      return '';
  }
}

export function timeSavedMinutes(drafts: Enquiry[], roi: Config['roi']): number {
  return drafts.reduce((sum, e) => sum + roi.minutesPerEnquiry + roi.minutesPerLine * (e.lineCount ?? 0), 0);
}

export function usageCost(rows: Array<{ inputTokens: number; outputTokens: number; calls: number }>, llm: Pick<Config['llm'], 'priceInPerMTok' | 'priceOutPerMTok'>) {
  const inputTokens = rows.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = rows.reduce((s, r) => s + r.outputTokens, 0);
  return {
    calls: rows.reduce((s, r) => s + r.calls, 0),
    inputTokens,
    outputTokens,
    estimatedUsd: (inputTokens * llm.priceInPerMTok + outputTokens * llm.priceOutPerMTok) / 1_000_000,
  };
}

export function buildDailySummary(repo: Repository, cfg: Config, now: Date = new Date()): DailySummary {
  const since = new Date(now.getTime() - DAY).toISOString();
  const today = repo.enquiriesSince(since);
  const week = repo.enquiriesSince(new Date(now.getTime() - 7 * DAY).toISOString());
  const drafts = today.filter((e) => isDraft(e.status));
  const day = calendarDate(now, cfg.timezone);
  const lastBackupAt = repo.getMeta('last_backup_at') || undefined;

  return {
    date: day,
    received: today.length,
    drafts: drafts.length,
    draftsToPrice: drafts.filter((e) => e.status === 'QUOTE_CREATED_WITH_EXCEPTIONS').length,
    flaggedForReview: drafts.filter((e) => e.reviewFlags.length > 0).length,
    needAttention: week
      .filter((e) => isAttention(e.status))
      .slice(0, 10)
      .map((e) => ({ id: e.id, status: e.status, sender: e.senderEmail, subject: e.subject, reason: attentionReason(e) })),
    timeSavedMinutes: timeSavedMinutes(drafts, cfg.roi),
    ...(cfg.roi.staffCostPerHour ? { timeSavedValue: { amount: (timeSavedMinutes(drafts, cfg.roi) / 60) * cfg.roi.staffCostPerHour, currency: drafts.find((e) => e.currencyCode)?.currencyCode ?? 'INR' } } : {}),
    llm: usageCost(repo.llmUsageSince(calendarDate(new Date(now.getTime() - DAY), cfg.timezone)), cfg.llm),
    backup: { ...(lastBackupAt ? { lastAt: lastBackupAt } : {}), ok: repo.getMeta('last_backup_ok') !== '0' },
    health: computeHealth(repo, cfg, now),
    ...(cfg.dashboard.publicUrl ? { dashboardUrl: cfg.dashboard.publicUrl } : {}),
  };
}
