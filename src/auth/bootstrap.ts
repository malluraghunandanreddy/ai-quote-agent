import type { Config } from '../config';
import type { UserStore } from '../db/users';
import { hashPassword, looksLikeEmail } from './passwords';

/**
 * The very first login. When nobody has an account yet and DASHBOARD_PASSWORD is set, create one owner from it (email
 * from DASHBOARD_OWNER_EMAIL, else the internal alert address). They must choose their own password at first sign-in,
 * so the value left in .env stops working. Once any account exists this does nothing, whatever .env says.
 */
export async function ensureOwner(users: UserStore, config: Config): Promise<{ created: boolean; email?: string; reason?: string }> {
  if (users.count() > 0) return { created: false };
  const password = config.dashboard.password;
  if (!password) return { created: false, reason: 'no_password' };
  const email = config.dashboard.ownerEmail ?? (looksLikeEmail(config.notify.internal.toLowerCase()) ? config.notify.internal.toLowerCase() : undefined);
  if (!email) return { created: false, reason: 'no_email' };
  users.create({ email, name: 'Owner', role: 'owner', passwordHash: await hashPassword(password), mustChangePassword: true });
  users.logEvent({ actorLabel: 'System', event: 'owner_created', target: email, detail: 'First owner created from the settings file' });
  return { created: true, email };
}
