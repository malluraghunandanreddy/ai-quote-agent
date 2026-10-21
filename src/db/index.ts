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

/** Columns added after the first release. CREATE TABLE IF NOT EXISTS does not touch an existing file, so add them here. */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ['enquiries', 'customer_name', 'TEXT'],
  ['enquiries', 'match_tier', 'TEXT'],
  ['enquiries', 'company_in_email', 'TEXT'],
  ['enquiries', 'email_date', 'TEXT'],
  ['enquiries', 'unreadable_rows', 'INTEGER'],
  ['enquiries', 'review_flags', 'TEXT'],
  ['enquiries', 'hold_until', 'TEXT'],
];

function migrate(db: Db): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!have.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
  migrate(db);
  return db;
}
