import readline from 'node:readline';
import { generatePassword, hashPassword, looksLikeEmail, passwordProblem } from '../auth/passwords';
import { ROLES, isRole, roleLabel } from '../auth/rbac';
import { getConfig } from '../config';
import { openDatabase } from '../db';
import { UserError, UserStore } from '../db/users';

/**
 * Manage dashboard logins from the server's command line. This is the way in when nobody can sign in (a forgotten
 * owner password, the first login on a fresh install). Everything else is done by owners and managers in the dashboard.
 *
 *   npm run users                                    list everyone
 *   npm run users -- add <email> "<name>" <role>     create a login with a one-time password (printed once)
 *   npm run users -- reset <email>                   new one-time password, signs them out everywhere
 *   npm run users -- role <email> <role>             change someone's role
 *   npm run users -- off <email> | on <email>        switch a login off or back on
 *   npm run users -- unlock <email>                  clear a "too many wrong passwords" pause
 *   npm run users -- passwd <email>                  type a chosen password instead of a generated one
 */

const USAGE = `Usage:
  npm run users
  npm run users -- add <email> "<name>" <${ROLES.join('|')}>
  npm run users -- reset <email>
  npm run users -- passwd <email>
  npm run users -- role <email> <${ROLES.join('|')}>
  npm run users -- off <email>
  npm run users -- on <email>
  npm run users -- unlock <email>`;

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(prompt)) write(s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const config = getConfig();
  const db = openDatabase(config.dbPath);
  const users = new UserStore(db);
  const log = (event: string, target: string, detail?: string): void => users.logEvent({ actorLabel: 'Server command line', event, target, ...(detail ? { detail } : {}) });
  const need = (email: string | undefined) => {
    const u = email ? users.findByEmail(email.toLowerCase()) : undefined;
    if (!u) throw new UserError('not_found', `No login for ${email ?? '(no email given)'}.`);
    return u;
  };
  try {
    if (!cmd || cmd === 'list') {
      const rows = users.list();
      if (rows.length === 0) console.log('Nobody has a login yet. Create the first owner:\n  npm run users -- add you@company.com "Your Name" owner');
      for (const u of rows) console.log(`${u.active ? ' ' : 'x'} ${roleLabel(u.role).padEnd(8)} ${u.email.padEnd(36)} ${u.name}${u.mustChangePassword ? '  (has not signed in yet)' : ''}${users.isLocked(u) ? '  (paused after wrong passwords)' : ''}`);
      return 0;
    }
    if (cmd === 'add') {
      const [email, name, role] = args;
      if (!email || !name || !role || !looksLikeEmail(email) || !isRole(role)) {
        console.error(USAGE);
        return 2;
      }
      const temp = generatePassword();
      const u = users.create({ email, name, role, passwordHash: await hashPassword(temp), mustChangePassword: true });
      log('user_created', u.email, roleLabel(u.role));
      console.log(`Created ${roleLabel(u.role)} login for ${u.name} <${u.email}>.\nOne-time password (shown only now): ${temp}\nThey will be asked to choose their own at first sign-in.`);
      return 0;
    }
    if (cmd === 'reset') {
      const u = need(args[0]);
      const temp = generatePassword();
      users.setPassword(u.id, await hashPassword(temp), true);
      log('password_reset', u.email);
      console.log(`New one-time password for ${u.email} (shown only now): ${temp}\nThey were signed out everywhere and must choose a new password at next sign-in.`);
      return 0;
    }
    if (cmd === 'passwd') {
      const u = need(args[0]);
      const one = await askHidden('New password: ');
      const two = await askHidden('Again: ');
      const problem = one !== two ? 'The two entries are not the same.' : passwordProblem(one, { email: u.email, name: u.name });
      if (problem) {
        console.error(problem);
        return 2;
      }
      users.setPassword(u.id, await hashPassword(one), false);
      log('password_reset', u.email, 'chosen on the command line');
      console.log(`Password set for ${u.email}.`);
      return 0;
    }
    if (cmd === 'role') {
      const u = need(args[0]);
      const role = args[1];
      if (!role || !isRole(role)) {
        console.error(USAGE);
        return 2;
      }
      users.setRole(u.id, role);
      log('role_changed', u.email, `${roleLabel(u.role)} → ${roleLabel(role)}`);
      console.log(`${u.email} is now ${roleLabel(role)}.`);
      return 0;
    }
    if (cmd === 'off' || cmd === 'on') {
      const u = need(args[0]);
      users.setActive(u.id, cmd === 'on');
      log(cmd === 'on' ? 'user_reactivated' : 'user_deactivated', u.email);
      console.log(`${u.email} is switched ${cmd}.`);
      return 0;
    }
    if (cmd === 'unlock') {
      const u = need(args[0]);
      users.unlock(u.id);
      log('user_unlocked', u.email);
      console.log(`${u.email} can try signing in again.`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof UserError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
