import type { Repository } from '../db/repository';
import type { UserStore } from '../db/users';
import { logger } from '../logger';

/**
 * Data retention: delete enquiry records (sender, subject, audit trail, notification records) older than
 * `retentionDays`. Work in progress is never touched. Customers, items and quotes live in Zoho and are not affected.
 * Team notes go with their enquiry; the sign-in and activity log is trimmed to the same period; expired sessions are dropped.
 */
export function runRetention(repo: Repository, retentionDays: number, now: Date = new Date(), users?: UserStore): number {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000).toISOString();
  const removed = repo.purgeOlderThan(cutoff);
  if (users) {
    const events = users.purgeEventsOlderThan(cutoff);
    const sessions = users.purgeExpiredSessions();
    logger.info('Activity log trimmed', { events, expiredSessions: sessions });
  }
  repo.setMeta('last_purge_at', now.toISOString());
  repo.setMeta('last_purge_count', String(removed));
  logger.info('Retention purge finished', { olderThanDays: retentionDays, removed });
  return removed;
}
