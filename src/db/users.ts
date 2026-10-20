import crypto from 'node:crypto';
import { isRole, type Role } from '../auth/rbac';
import type { Db } from './index';

export const SESSION_HOURS = 12;
export const IDLE_HOURS = 4;
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  createdBy: number | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export type UserErrorCode = 'duplicate_email' | 'last_owner' | 'not_found' | 'invalid';

export class UserError extends Error {
  constructor(
    readonly code: UserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  role: string;
  password_hash: string;
  must_change_password: number;
  active: number;
  failed_attempts: number;
  locked_until: string | null;
  created_by: number | null;
  created_at: string;
  last_login_at: string | null;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.display_name,
    role: isRole(r.role) ? r.role : 'viewer', // an unknown role in the file gets the least access, never the most
    active: r.active === 1,
    mustChangePassword: r.must_change_password === 1,
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const clean = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SecurityEvent {
  id: number;
  at: string;
  actorId: number | null;
  actor: string | null;
  event: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export interface EventInput {
  actor?: { id: number; name: string } | null;
  /** Used when there is no signed-in actor, e.g. a failed sign-in. */
  actorLabel?: string;
  event: string;
  target?: string | null;
  detail?: string | null;
  ip?: string | null;
}

/** People, their sessions, and the log of who did what. All state lives in the same SQLite file as everything else. */
export class UserStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private nowIso(): string {
    return this.clock().toISOString();
  }

  // --- people ---------------------------------------------------------------------------------------------------------

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  activeOwners(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").get() as { n: number }).n;
  }

  get(id: number): User | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toUser(r) : undefined;
  }

  findByEmail(email: string): User | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    return r ? toUser(r) : undefined;
  }

  credentials(email: string): { user: User; hash: string } | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    return r ? { user: toUser(r), hash: r.password_hash } : undefined;
  }

  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY active DESC, created_at ASC, id ASC').all() as UserRow[];
    return rows.map(toUser);
  }

  create(input: { email: string; name: string; role: Role; passwordHash: string; mustChangePassword: boolean; createdBy?: number | null }): User {
    const email = input.email.trim().toLowerCase();
    const name = clean(input.name, 80);
    if (!email || !name || !isRole(input.role)) throw new UserError('invalid', 'Name, email and role are required.');
    const now = this.nowIso();
    try {
      const info = this.db
        .prepare('INSERT INTO users (email, display_name, role, password_hash, must_change_password, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .run(email, name, input.role, input.passwordHash, input.mustChangePassword ? 1 : 0, input.createdBy ?? null, now, now);
      return this.get(Number(info.lastInsertRowid)) as User;
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new UserError('duplicate_email', 'Someone with that email already has a login.');
      throw err;
    }
  }

  private requireUser(id: number): User {
    const u = this.get(id);
    if (!u) throw new UserError('not_found', 'That person was not found.');
    return u;
  }

  /** There must always be someone who can sign in as owner. Checked inside the same transaction as the change. */
  private guardLastOwner(user: User): void {
    if (user.role === 'owner' && user.active && this.activeOwners() <= 1) throw new UserError('last_owner', 'This is the only active owner. Make someone else an owner first.');
  }

  setRole(id: number, role: Role): User {
    return this.db.transaction(() => {
      const u = this.requireUser(id);
      if (!isRole(role)) throw new UserError('invalid', 'Unknown role.');
      if (role !== 'owner') this.guardLastOwner(u);
      this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, this.nowIso(), id);
      return this.requireUser(id);
    }).immediate();
  }

  setActive(id: number, active: boolean): User {
    return this.db.transaction(() => {
      const u = this.requireUser(id);
      if (!active) this.guardLastOwner(u);
      this.db.prepare('UPDATE users SET active = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(active ? 1 : 0, this.nowIso(), id);
      if (!active) this.deleteSessionsFor(id);
      return this.requireUser(id);
    }).immediate();
  }

  setName(id: number, name: string): void {
    const n = clean(name, 80);
    if (!n) throw new UserError('invalid', 'Please enter a name.');
    this.db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(n, this.nowIso(), id);
  }

  /** Sets a new password, clears any lock, and (unless told otherwise) signs the person out everywhere. */
  setPassword(id: number, passwordHash: string, mustChangePassword: boolean, keepSessionId?: string): void {
    this.db.transaction(() => {
      this.requireUser(id);
      this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(passwordHash, mustChangePassword ? 1 : 0, this.nowIso(), id);
      this.deleteSessionsFor(id, keepSessionId);
    }).immediate();
  }

  isLocked(user: User): boolean {
    return user.lockedUntil !== null && user.lockedUntil > this.nowIso();
  }

  /** Counts a wrong password. After MAX_FAILURES in a row the account pauses for LOCK_MINUTES. */
  recordFailure(id: number): { locked: boolean } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT failed_attempts AS n FROM users WHERE id = ?').get(id) as { n: number } | undefined;
      if (!row) return { locked: false };
      const n = row.n + 1;
      if (n >= MAX_FAILURES) {
        const until = new Date(this.clock().getTime() + LOCK_MINUTES * 60_000).toISOString();
        this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(until, id);
        return { locked: true };
      }
      this.db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(n, id);
      return { locked: false };
    }).immediate();
  }

  recordSuccess(id: number): void {
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(this.nowIso(), id);
  }

  unlock(id: number): void {
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(id);
  }

  // --- sessions -------------------------------------------------------------------------------------------------------

  createSession(userId: number, meta: { ip?: string | undefined; userAgent?: string | undefined } = {}): { token: string; csrf: string; maxAgeSeconds: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = this.clock();
    const expires = new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString();
    this.db
      .prepare('INSERT INTO sessions (id, user_id, csrf, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, csrf, now.toISOString(), now.toISOString(), expires, meta.ip ? clean(meta.ip, 64) : null, meta.userAgent ? clean(meta.userAgent, 300) : null);
    return { token, csrf, maxAgeSeconds: SESSION_HOURS * 3600 };
  }

  /** The person behind a cookie, or undefined if it is unknown, expired, idle too long, or the person was switched off. */
  sessionFor(token: string | undefined): { user: User; csrf: string; sessionId: string } | undefined {
    if (!token || token.length > 200) return undefined;
    const id = sha256(token);
    const row = this.db
      .prepare('SELECT s.csrf AS csrf, s.last_seen_at AS last_seen_at, s.expires_at AS expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
      .get(id) as (UserRow & { csrf: string; last_seen_at: string; expires_at: string }) | undefined;
    if (!row) return undefined;
    const now = this.clock();
    const idleCutoff = new Date(now.getTime() - IDLE_HOURS * 3_600_000).toISOString();
    if (row.expires_at <= now.toISOString() || row.last_seen_at <= idleCutoff || row.active !== 1) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return undefined;
    }
    if (now.getTime() - Date.parse(row.last_seen_at) > 60_000) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), id);
    return { user: toUser(row), csrf: row.csrf, sessionId: id };
  }

  idOf(token: string | undefined): string | undefined {
    return token ? sha256(token) : undefined;
  }

  deleteSession(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
  }

  deleteSessionsFor(userId: number, exceptSessionId?: string): number {
    return this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptSessionId ?? '').changes;
  }

  sessionsFor(userId: number): SessionInfo[] {
    const rows = this.db.prepare('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC').all(userId, this.nowIso()) as Array<{
      id: string;
      created_at: string;
      last_seen_at: string;
      ip: string | null;
      user_agent: string | null;
    }>;
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent }));
  }

  purgeExpiredSessions(): number {
    const idleCutoff = new Date(this.clock().getTime() - IDLE_HOURS * 3_600_000).toISOString();
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(this.nowIso(), idleCutoff).changes;
  }

  // --- the log --------------------------------------------------------------------------------------------------------

  logEvent(e: EventInput): void {
    this.db
      .prepare('INSERT INTO security_events (at, actor_id, actor_label, event, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.nowIso(), e.actor?.id ?? null, e.actor ? clean(e.actor.name, 80) : e.actorLabel ? clean(e.actorLabel, 120) : null, e.event, e.target ? clean(e.target, 200) : null, e.detail ? clean(e.detail, 300) : null, e.ip ? clean(e.ip, 64) : null);
  }

  events(opts: { kinds?: readonly string[]; limit: number; offset: number }): { rows: SecurityEvent[]; total: number } {
    const kinds = opts.kinds && opts.kinds.length ? opts.kinds : undefined;
    const where = kinds ? `WHERE event IN (${kinds.map(() => '?').join(',')})` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM security_events ${where}`).get(...(kinds ?? [])) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM security_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...(kinds ?? []), opts.limit, opts.offset) as Array<{
      id: number;
      at: string;
      actor_id: number | null;
      actor_label: string | null;
      event: string;
      target: string | null;
      detail: string | null;
      ip: string | null;
    }>;
    return { total, rows: rows.map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, actor: r.actor_label, event: r.event, target: r.target, detail: r.detail, ip: r.ip })) };
  }

  purgeEventsOlderThan(cutoffIso: string): number {
    return this.db.prepare('DELETE FROM security_events WHERE at < ?').run(cutoffIso).changes;
  }
}

// --- notes on enquiries ---------------------------------------------------------------------------------------------------

export type NoteKind = 'note' | 'handled' | 'reopened';

export interface EnquiryNote {
  id: number;
  enquiryId: number;
  author: string;
  kind: NoteKind;
  body: string;
  createdAt: string;
}

export class NoteStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  add(enquiryId: number, user: { id: number; name: string }, kind: NoteKind, body: string): void {
    this.db
      .prepare('INSERT INTO enquiry_notes (enquiry_id, user_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(enquiryId, user.id, clean(user.name, 80), kind, body.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500), this.clock().toISOString());
  }

  forEnquiry(enquiryId: number): EnquiryNote[] {
    const rows = this.db.prepare('SELECT * FROM enquiry_notes WHERE enquiry_id = ? ORDER BY id ASC').all(enquiryId) as Array<{ id: number; enquiry_id: number; author: string; kind: NoteKind; body: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, enquiryId: r.enquiry_id, author: r.author, kind: r.kind, body: r.body, createdAt: r.created_at }));
  }

  /** Enquiries whose most recent "handled / reopened" mark is "handled". */
  handledIds(): Set<number> {
    const rows = this.db.prepare("SELECT enquiry_id, kind FROM enquiry_notes WHERE kind IN ('handled','reopened') ORDER BY id ASC").all() as Array<{ enquiry_id: number; kind: NoteKind }>;
    const out = new Set<number>();
    for (const r of rows) {
      if (r.kind === 'handled') out.add(r.enquiry_id);
      else out.delete(r.enquiry_id);
    }
    return out;
  }

  isHandled(enquiryId: number): boolean {
    const r = this.db.prepare("SELECT kind FROM enquiry_notes WHERE enquiry_id = ? AND kind IN ('handled','reopened') ORDER BY id DESC LIMIT 1").get(enquiryId) as { kind: NoteKind } | undefined;
    return r?.kind === 'handled';
  }

  noteCounts(ids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (ids.length === 0) return out;
    const rows = this.db.prepare(`SELECT enquiry_id, COUNT(*) AS n FROM enquiry_notes WHERE kind = 'note' AND enquiry_id IN (${ids.map(() => '?').join(',')}) GROUP BY enquiry_id`).all(...ids) as Array<{ enquiry_id: number; n: number }>;
    for (const r of rows) out.set(r.enquiry_id, r.n);
    return out;
  }
}
