import cron from 'node-cron';
import { ensureOwner } from './auth/bootstrap';
import { ConfigError, getConfig, requireImap } from './config';
import { startDashboard } from './dashboard/server';
import { NoteStore, UserStore } from './db/users';
import { errorMessage, logger, setLogLevel } from './logger';
import { runBackup } from './ops/backup';
import { runRetention } from './ops/maintenance';
import { HealthMonitor, buildDailySummary } from './ops/monitor';
import { createRuntime, runWorkflowCycle, runWorkflowOnce, type Runtime } from './workflow/processor';

/**
 * Long-running service: polls the monitored mailbox on a cron schedule (default every 2 minutes), serves the dashboard,
 * backs the database up every night, applies the retention period, and sends the daily summary and any "service is down"
 * alerts. `npm run process-now` (or `npm start -- --once`) runs a single cycle and exits instead.
 */
async function main(): Promise<void> {
  const config = getConfig();
  setLogLevel(config.logLevel);

  if (process.argv.includes('--once')) {
    await runWorkflowOnce();
    return;
  }

  requireImap(config);
  for (const [name, expr] of [['POLL_CRON', config.schedule.cron], ['BACKUP_CRON', config.backup.cron], ['DAILY_SUMMARY_CRON', config.alerts.dailySummaryCron]] as const) {
    if (expr !== null && !cron.validate(expr)) throw new ConfigError(`${name} "${expr}" is not a valid cron expression`);
  }

  const rt: Runtime = createRuntime(config);
  const monitor = new HealthMonitor(rt.repo, config, rt.notifier, rt.clock);
  const users = new UserStore(rt.db);
  const notes = new NoteStore(rt.db);
  let running: Promise<void> | null = null;

  const tick = (trigger: string): void => {
    if (running) {
      logger.warn('Previous cycle is still running; skipping this tick', { trigger });
      return;
    }
    running = (async () => {
      try {
        const summary = await runWorkflowCycle(rt);
        if (summary.fetched > 0) logger.info('Cycle finished', { trigger, ...summary });
        else logger.debug('Cycle finished: no unread mail', { trigger });
        await monitor.recordCycle({ ok: true, summary });
      } catch (err) {
        // Mailbox unreachable, Zoho down, ...: log and try again on the next tick. Several in a row alert a person.
        logger.error('Cycle failed', { trigger, error: errorMessage(err) });
        await monitor.recordCycle({ ok: false, error: err }).catch((e) => logger.error('Could not record the failed cycle', { error: errorMessage(e) }));
      } finally {
        running = null;
      }
    })();
  };

  const task = cron.schedule(config.schedule.cron, () => tick('cron'), { name: 'poll-mailbox' });

  // --- nightly: backup, then apply the retention period -------------------------------------------------------
  const nightly = async (): Promise<void> => {
    try {
      await runBackup(rt.db, rt.repo, config.backup);
    } catch {
      // already logged and recorded for the Status page
    }
    try {
      const now = rt.clock();
      runRetention(rt.repo, config.retentionDays, now, users);
    } catch (err) {
      logger.error('Retention purge failed', { error: errorMessage(err) });
    }
  };
  const backupTask = cron.schedule(config.backup.cron, () => void nightly(), { name: 'nightly-backup', timezone: config.timezone });
  const lastBackup = rt.repo.getMeta('last_backup_at');
  if (!lastBackup || rt.clock().getTime() - Date.parse(lastBackup) > 24 * 3_600_000) void nightly();

  // --- every morning: the summary email --------------------------------------------------------------------------
  const summaryTask = config.alerts.dailySummaryCron
    ? cron.schedule(
        config.alerts.dailySummaryCron,
        () => {
          void rt.notifier.dailySummary(buildDailySummary(rt.repo, config, rt.clock())).catch((err) => logger.error('Daily summary failed', { error: errorMessage(err) }));
        },
        { name: 'daily-summary', timezone: config.timezone },
      )
    : null;

  // --- the dashboard (a problem here never stops quotes being created) ---------------------------------------------
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | null = null;
  try {
    const boot = await ensureOwner(users, config);
    if (boot.created) logger.info('Created the first dashboard owner login', { email: boot.email, note: 'they choose their own password at first sign-in' });
    if (users.count() === 0) {
      logger.warn('The dashboard is off: nobody has a login yet. Set DASHBOARD_PASSWORD and DASHBOARD_OWNER_EMAIL in .env, or run: npm run users -- add you@company.com "Your Name" owner');
    } else {
      dashboard = await startDashboard({ config, repo: rt.repo, users, notes, clock: rt.clock, zoho: { api: rt.zoho, organizationId: rt.zohoConfig.organizationId } });
      logger.info('Dashboard started', { address: `http://${config.dashboard.host}:${dashboard.port}`, publicUrl: config.dashboard.publicUrl });
    }
  } catch (err) {
    logger.error('The dashboard could not start; quotes are unaffected', { error: errorMessage(err) });
  }

  logger.info('Quote agent started', {
    mailbox: config.imap?.user,
    folder: config.imap?.folder,
    schedule: config.schedule.cron,
    zoho: config.zoho ? `books.zoho.${config.zoho.dc} (org ${config.zoho.organizationId})` : 'NOT CONFIGURED',
    llm: config.llm.enabled ? `anthropic / ${config.llm.model}` : `disabled (${config.llm.disabledReason}); rules only`,
    notifications: config.smtp ? `SMTP ${config.smtp.host}` : 'log only (SMTP_HOST not set)',
  });
  if (config.schedule.runOnStart) tick('startup');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    await task.stop();
    await backupTask.stop();
    await summaryTask?.stop();
    await dashboard?.close();
    if (running) await running; // let the in-flight enquiry finish so it is never left half-recorded
    rt.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal', { error: errorMessage(err) });
  process.exit(1);
});
