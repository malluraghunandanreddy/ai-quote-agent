import cron from 'node-cron';
import { ConfigError, getConfig, requireImap } from './config';
import { errorMessage, logger, setLogLevel } from './logger';
import { createRuntime, runWorkflowCycle, runWorkflowOnce, type Runtime } from './workflow/processor';

/**
 * Long-running service: polls the monitored mailbox on a cron schedule (default every 2 minutes).
 * `npm run process-now` (or `npm start -- --once`) runs a single cycle and exits instead.
 */
async function main(): Promise<void> {
  const config = getConfig();
  setLogLevel(config.logLevel);

  if (process.argv.includes('--once')) {
    await runWorkflowOnce();
    return;
  }

  requireImap(config);
  if (!cron.validate(config.schedule.cron)) {
    throw new ConfigError(`POLL_CRON "${config.schedule.cron}" is not a valid cron expression`);
  }

  const rt: Runtime = createRuntime(config);
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
      } catch (err) {
        // Mailbox unreachable, Zoho down, ...: log and try again on the next tick.
        logger.error('Cycle failed', { trigger, error: errorMessage(err) });
      } finally {
        running = null;
      }
    })();
  };

  const task = cron.schedule(config.schedule.cron, () => tick('cron'), { name: 'poll-mailbox' });
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
