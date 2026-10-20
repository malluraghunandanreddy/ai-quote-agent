/** Minimal leveled logger. Redacts anything that looks like a credential before it reaches the console. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|cookie)/i;

let threshold = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(redact(meta))}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};
