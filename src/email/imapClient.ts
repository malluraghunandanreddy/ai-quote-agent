import { ImapFlow } from 'imapflow';
import type { ImapConfig } from '../config';
import { logger, errorMessage } from '../logger';

interface EnvelopeAddress {
  address?: string | undefined;
}
export interface EnvelopeLike {
  to?: EnvelopeAddress[] | undefined;
  cc?: EnvelopeAddress[] | undefined;
}

/** Was this message addressed (To or Cc) to exactly this address? Case-insensitive, so `Quotes+RFQ@x.com` matches. */
export function isAddressedTo(envelope: EnvelopeLike | undefined, address: string): boolean {
  const wanted = address.trim().toLowerCase();
  return [...(envelope?.to ?? []), ...(envelope?.cc ?? [])].some((a) => a.address?.trim().toLowerCase() === wanted);
}

/** The slice of an IMAP connection that choosing messages needs (so it can be tested without a server). */
export interface MailboxQuery {
  search(query: Record<string, unknown>, options: Record<string, unknown>): Promise<number[] | false>;
  fetch(range: string, query: Record<string, unknown>, options: Record<string, unknown>): AsyncIterable<{ uid: number; envelope?: EnvelopeLike }>;
}

/** Look back this far when only mail to one address is wanted (keeps the check cheap in a busy personal inbox). */
const ONLY_TO_LOOKBACK_DAYS = 14;

/**
 * Which unread messages should be processed, oldest first. Normally every unread message. With `onlyTo`, only those
 * addressed to that exact address: the others are never opened, flagged or moved, and are reported as `ignored`.
 * Only sender, recipients and subject of the other unread messages are looked at, never their text.
 */
export async function findUnreadUids(client: MailboxQuery, onlyTo?: string, now: Date = new Date()): Promise<{ uids: number[]; ignored: number }> {
  const query: Record<string, unknown> = onlyTo ? { seen: false, since: new Date(now.getTime() - ONLY_TO_LOOKBACK_DAYS * 86_400_000) } : { seen: false };
  const found = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
  if (!onlyTo) return { uids: found, ignored: 0 };
  const keep: number[] = [];
  for (let i = 0; i < found.length; i += 200) {
    const chunk = found.slice(i, i + 200);
    for await (const m of client.fetch(chunk.join(','), { envelope: true, uid: true }, { uid: true })) {
      if (isAddressedTo(m.envelope, onlyTo)) keep.push(m.uid);
    }
  }
  keep.sort((a, b) => a - b);
  return { uids: keep, ignored: found.length - keep.length };
}

export interface FetchedMessage {
  uid: number;
  source: Buffer;
}

export interface MailboxBatch {
  uidValidity: bigint;
  messages: FetchedMessage[];
}

/** Hard cap on one raw message held in memory (mail servers rarely accept more than ~25 MB anyway). */
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;

/**
 * Read-then-mark mailbox access over implicit TLS.
 *
 * Fetching uses BODY.PEEK, so reading a message never sets \Seen. The connection is closed while the (slow)
 * processing runs; only once a message is fully handled does `markHandled` reconnect and flag it \Seen (and
 * optionally move it). If the server's UIDVALIDITY changed in between, nothing is flagged: the database
 * de-duplication then turns the next fetch into a harmless no-op.
 */
export class ImapMailbox {
  constructor(
    private readonly cfg: ImapConfig,
    private readonly batchLimit: number,
  ) {}

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: true,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      tls: { minVersion: 'TLSv1.2' },
      logger: false, // imapflow would otherwise log protocol traffic, including credentials
    });
    // Without a listener an idle-socket error would crash the process.
    client.on('error', (err: Error) => logger.warn('IMAP connection error', { error: err.message }));
    await client.connect();
    return client;
  }

  private async close(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  /** Oldest-first unread messages (up to the batch limit), without changing any flag. */
  async fetchUnseen(): Promise<MailboxBatch> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(this.cfg.folder);
      try {
        const mailbox = client.mailbox;
        const uidValidity = mailbox && typeof mailbox !== 'boolean' ? mailbox.uidValidity : 0n;
        const { uids: unread } = await findUnreadUids(client as unknown as MailboxQuery, this.cfg.onlyTo);
        const uids = unread.slice(0, this.batchLimit);

        const messages: FetchedMessage[] = [];
        for (const uid of uids) {
          const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
          if (!meta) continue;
          if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) {
            logger.error('Skipping oversized message (left unread for manual handling)', { uid, size: meta.size });
            continue;
          }
          const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
          if (full && full.source) messages.push({ uid, source: full.source });
        }
        return { uidValidity, messages };
      } finally {
        lock.release();
      }
    } finally {
      await this.close(client);
    }
  }

  /** Flag as \Seen (and move, if configured). Call only after the database record and all notifications are done. */
  async markHandled(uidValidity: bigint, uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(this.cfg.folder);
      try {
        const mailbox = client.mailbox;
        const current = mailbox && typeof mailbox !== 'boolean' ? mailbox.uidValidity : 0n;
        if (current !== uidValidity) {
          logger.warn('Mailbox UIDVALIDITY changed during processing; not flagging messages', {
            before: String(uidValidity),
            after: String(current),
          });
          return;
        }
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        if (this.cfg.processedFolder) {
          await client.messageMove(uids, this.cfg.processedFolder, { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      // The enquiry is already recorded; if flagging fails the next poll sees a duplicate and retries the flag.
      logger.error('Could not flag handled messages as read', { error: errorMessage(err), uids });
    } finally {
      await this.close(client);
    }
  }
}
