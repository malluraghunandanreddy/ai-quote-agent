import { ensureOwner } from '../auth/bootstrap';
import { getConfig } from '../config';
import { openDatabase } from '../db';
import { Repository } from '../db/repository';
import { UserStore } from '../db/users';
import { errorMessage, logger, setLogLevel } from '../logger';
import { startDashboard } from './server';

/**
 * Runs just the dashboard, reading the same database the service writes (npm run dashboard).
 * Handy for demos and for looking at the data without starting the mailbox poller.
 */
async function main(): Promise<void> {
  const config = getConfig();
  setLogLevel(config.logLevel);
  const db = openDatabase(config.dbPath);
  const repo = new Repository(db, { dedupeWindowHours: config.limits.dedupeWindowHours, maxAttempts: config.limits.maxAttempts, staleProcessingMinutes: config.limits.staleProcessingMinutes });
  const users = new UserStore(db);
  const boot = await ensureOwner(users, config);
  if (boot.created) console.log(`Created the first owner login: ${boot.email} (sign in with DASHBOARD_PASSWORD, then choose a new password).`);
  if (users.count() === 0) {
    console.error('Nobody has a dashboard login yet. Either set DASHBOARD_PASSWORD (and DASHBOARD_OWNER_EMAIL) in .env and run this again, or run:\n  npm run users -- add you@company.com "Your Name" owner');
    db.close();
    process.exitCode = 2;
    return;
  }
  const { port, close } = await startDashboard({ config, repo, users });
  console.log(`Dashboard running at http://${config.dashboard.host === '0.0.0.0' ? 'localhost' : config.dashboard.host}:${port}  (database: ${config.dbPath})`);
  const stop = async (): Promise<void> => {
    await close();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

main().catch((err) => {
  logger.error('Dashboard failed to start', { error: errorMessage(err) });
  process.exit(1);
});
