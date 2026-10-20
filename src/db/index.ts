import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** schema.sql lives at the project root; walk up from here so it is found from src/ and from dist/. */
function findSchema(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'schema.sql');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('schema.sql not found (expected in the project root)');
}

/**
 * Open (creating if needed) the SQLite database and apply schema.sql.
 * WAL + busy_timeout let the CLI (`npm run process-now`) and the scheduler share the file safely.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(findSchema(), 'utf8'));
  return db;
}
