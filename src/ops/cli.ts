import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config';
import { openDatabase } from '../db';
import { Repository } from '../db/repository';
import { errorMessage, logger, setLogLevel } from '../logger';
import { listBackups, restoreBackup, runBackup, verifyBackup } from './backup';

/**
 * Operations commands.
 *   backup                 take a backup now (safe while the service runs)
 *   list                   show the backups on disk
 *   restore <file> --yes   replace the database with a backup (STOP THE SERVICE FIRST)
 */
async function main(): Promise<number> {
  const config = getConfig();
  setLogLevel(config.logLevel);
  const [command, arg, flag] = process.argv.slice(2);

  switch (command) {
    case 'backup': {
      const db = openDatabase(config.dbPath);
      try {
        const repo = new Repository(db, { dedupeWindowHours: config.limits.dedupeWindowHours, maxAttempts: config.limits.maxAttempts, staleProcessingMinutes: config.limits.staleProcessingMinutes });
        const r = await runBackup(db, repo, config.backup);
        console.log(`Backup written: ${r.file} (${Math.round(r.bytes / 1024)} KB, ${r.enquiries} enquiries). Removed ${r.removed.length} old backup(s).`);
        return 0;
      } finally {
        db.close();
      }
    }
    case 'list': {
      const files = listBackups(config.backup.dir);
      if (files.length === 0) console.log(`No backups in ${config.backup.dir}`);
      for (const f of files) console.log(`${path.basename(f)}  ${Math.round(fs.statSync(f).size / 1024)} KB`);
      return 0;
    }
    case 'restore': {
      if (!arg) {
        console.error('Usage: restore <backup file> --yes   (stop the service first)');
        return 2;
      }
      const file = path.isAbsolute(arg) || fs.existsSync(arg) ? arg : path.join(config.backup.dir, arg);
      const { enquiries } = verifyBackup(file);
      if (flag !== '--yes') {
        console.log(`Backup is healthy (${enquiries} enquiries). Nothing changed. Re-run with --yes to replace ${config.dbPath} (stop the service first).`);
        return 0;
      }
      const r = restoreBackup(file, config.dbPath);
      console.log(`Restored ${enquiries} enquiries into ${config.dbPath}. Previous database kept as ${r.safetyCopy ?? '(there was none)'}.`);
      return 0;
    }
    default:
      console.error('Commands: backup | list | restore <file> --yes');
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error('Command failed', { error: errorMessage(err) });
    process.exitCode = 1;
  });
