/** Formatting helpers shared by the dashboard. No dependencies on the rest of the dashboard. */

/** Escape text for HTML (element content and quoted attributes). Every dynamic value goes through this. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only ever link to http(s) addresses. */
export function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

export function fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency ?? ''} ${Math.round(amount)}`.trim();
  }
}

/** ₹4.2 L / ₹3.1 Cr for big rupee totals (how Indian buyers read money); full figure below a lakh. */
export function fmtMoneyShort(amount: number, currency: string | null | undefined): string {
  const cur = currency || 'INR';
  if (cur !== 'INR') return fmtMoney(amount, cur);
  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(2).replace(/\.?0+$/, '')} L`;
  return fmtMoney(amount, 'INR');
}

export function fmtUsd(usd: number): string {
  return usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function fmtDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
}

export function fmtDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`;
}

/** "12 min ago", "3 h ago", "yesterday", "14 Oct". */
export function relTime(iso: string | null | undefined, now: Date, timeZone: string): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const min = Math.round((now.getTime() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60 && localParts(new Date(t), timeZone).ymd === localParts(now, timeZone).ymd) return `${Math.round(min / 60)} h ago`;
  if (min < 48 * 60 && min >= 60) {
    const yesterday = localParts(new Date(now.getTime() - 24 * 60 * 60_000), timeZone).ymd;
    if (localParts(new Date(t), timeZone).ymd === yesterday) return 'yesterday';
  }
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short' }).format(new Date(t));
}

/** Two-letter avatar text from a company or person name ("M/s." and legal words ignored). */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '')
    .replace(/^\s*m\s*\/\s*s\.?\s+/i, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(pvt|ltd|private|limited|llp|the|and|co)$/i.test(w));
  const a = words[0]?.[0] ?? '?';
  const b = words[1]?.[0] ?? '';
  return (a + b).toUpperCase();
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date, weekday (0 = Monday) and hour of an instant in a timezone. */
export function localParts(date: Date, timeZone: string): { ymd: string; weekday: number; hour: number } {
  let fmt = partFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    partFormatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(String(p.weekday));
  return { ymd: `${p.year}-${p.month}-${p.day}`, weekday: Math.max(0, weekday), hour: Number(p.hour) % 24 };
}

/** The instant a calendar day started in `timeZone` (for "today" boundaries). */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const { ymd } = localParts(now, timeZone);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const shown = localParts(new Date(guess), timeZone);
  // offset = how far the zone's wall clock is ahead of UTC at that moment
  const wall = Date.UTC(Number(shown.ymd.slice(0, 4)), Number(shown.ymd.slice(5, 7)) - 1, Number(shown.ymd.slice(8, 10)), shown.hour);
  return new Date(guess - (wall - guess));
}

export const greeting = (now: Date, timeZone: string): string => {
  const h = localParts(now, timeZone).hour;
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/** Safe text for a CSV cell: quotes escaped, and a leading = + - @ neutralised so a spreadsheet never runs it as a formula. */
export function csvCell(value: unknown): string {
  let s = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
