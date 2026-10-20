export const COOKIE = 'qa_session';

/** Slows down password guessing from one address: a handful of wrong attempts, then a pause. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 8,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private recent(ip: string, now: number): number[] {
    const kept = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length > 0) this.failures.set(ip, kept);
    else this.failures.delete(ip);
    return kept;
  }

  blocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= this.max;
  }

  fail(ip: string, now = Date.now()): void {
    this.failures.set(ip, [...this.recent(ip, now), now]);
  }

  clear(ip: string): void {
    this.failures.delete(ip);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // a malformed cookie is simply ignored
    }
  }
  return out;
}

/** "Chrome on Mac" from a user-agent string: enough for a person to recognise their own devices. */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iPhone or iPad' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
