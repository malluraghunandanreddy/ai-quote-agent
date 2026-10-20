import { esc } from './format';

/**
 * Hand-built SVG charts (no library, no script needed to draw them). Specs follow the data-viz rules: bars at most 24px
 * thick with a 4px rounded data-end and a square baseline, 2px gaps between touching marks, hairline recessive grid,
 * labels only on the extremes, text in ink tokens (never the series colour), a native tooltip on every mark via
 * data-tip (shown by app.js) and the same value reachable in a table view.
 */

const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1).replace(/\.0$/, '') : '0');

/** A clean axis maximum above `max`, and three round ticks. */
export function niceAxis(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 4, ticks: [0, 2, 4] };
  if (max <= 4) return { top: 4, ticks: [0, 2, 4] };
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => (s * 4) >= max) ?? pow * 10;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: [0, top / 2, top] };
}

export const compact = (n: number): string =>
  n >= 10_000_000 ? `${(n / 10_000_000).toFixed(n >= 100_000_000 ? 0 : 1).replace(/\.0$/, '')} Cr`
  : n >= 100_000 ? `${(n / 100_000).toFixed(n >= 1_000_000 ? 0 : 1).replace(/\.0$/, '')} L`
  : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`
  : String(Math.round(n));

/** Path for a vertical bar: 4px rounded top, square baseline. */
function columnPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  return `M${f(x)} ${f(y + h)}V${f(y + r)}${r ? `Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}` : `H${f(x + w)}`}V${f(y + h)}Z`;
}

/** Path for a horizontal bar: square at the left baseline, 4px rounded right end. */
function barPath(x: number, y: number, w: number, h: number, roundEnd: boolean): string {
  const r = roundEnd ? Math.min(4, h / 2, w) : 0;
  return `M${f(x)} ${f(y)}H${f(x + w - r)}${r ? `Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}` : `V${f(y + h)}`}H${f(x)}Z`;
}

export interface DayBucket {
  /** Short x label, e.g. "20". */
  label: string;
  /** Second line for the first day and month changes, e.g. "Oct". */
  month?: string;
  /** Tooltip text. */
  tip: string;
  drafts: number;
  attention: number;
}

/** 14-day activity: drafts created (blue) stacked with enquiries that needed a person (red). */
export function activityChart(days: DayBucket[]): string {
  const W = 680, H = 236, L = 34, R = 10, T = 22, B = 38;
  const pw = W - L - R, ph = H - T - B;
  const max = Math.max(1, ...days.map((d) => d.drafts + d.attention));
  const { top, ticks } = niceAxis(max);
  const y = (v: number): number => T + ph - (v / top) * ph;
  const slot = pw / Math.max(1, days.length);
  const bw = Math.min(24, slot * 0.56);

  const grid = ticks
    .map((t) => `<line class="${t === 0 ? 'ax' : 'gl'}" x1="${L}" x2="${W - R}" y1="${f(y(t))}" y2="${f(y(t))}"/><text class="tm" x="${L - 8}" y="${f(y(t) + 4)}" text-anchor="end">${compact(t)}</text>`)
    .join('');

  const peak = days.reduce((best, d, i) => (d.drafts + d.attention > (days[best]?.drafts ?? 0) + (days[best]?.attention ?? 0) ? i : best), 0);
  const lastIdx = days.length - 1;

  const cols = days
    .map((d, i) => {
      const cx = L + slot * i + slot / 2, x = cx - bw / 2;
      const total = d.drafts + d.attention;
      const hDraft = (d.drafts / top) * ph, hAtt = (d.attention / top) * ph;
      const gap = d.drafts > 0 && d.attention > 0 ? 2 : 0;
      let marks = '';
      if (d.drafts > 0) marks += `<path class="mk f-blue" d="${columnPath(x, y(d.drafts), bw, Math.max(1.5, hDraft), d.attention === 0)}"/>`;
      if (d.attention > 0) marks += `<path class="mk f-crit" d="${columnPath(x, y(d.drafts + d.attention) , bw, Math.max(1.5, hAtt - gap), true)}"/>`;
      const label = total > 0 && (i === peak || i === lastIdx) ? `<text class="tv" x="${f(cx)}" y="${f(y(total) - 7)}" text-anchor="middle">${total}</text>` : '';
      const xl = i % 2 === (days.length - 1) % 2 ? `<text class="t" x="${f(cx)}" y="${H - 20}" text-anchor="middle">${esc(d.label)}</text>${d.month ? `<text class="tm" x="${f(cx)}" y="${H - 6}" text-anchor="middle">${esc(d.month)}</text>` : ''}` : '';
      return `<g class="col k${Math.min(i, 15)}" tabindex="0" data-tip="${esc(d.tip)}"><rect class="hit" x="${f(L + slot * i)}" y="${T - 8}" width="${f(slot)}" height="${ph + 8}"/>${marks}${label}</g>${xl}`;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Draft quotes created and enquiries that needed attention, per day, last ${days.length} days">${grid}${cols}</svg>`;
}

/** 7-point trend: 2px line, soft area, emphasised end-dot with a 2px surface ring. */
export function sparkline(values: number[], w = 92, h = 30): string {
  const pad = 5, max = Math.max(1, ...values), n = values.length;
  const px = (i: number): number => pad + (n === 1 ? 0 : (i / (n - 1)) * (w - pad * 2));
  const py = (v: number): number => h - pad - (v / max) * (h - pad * 2);
  const pts = values.map((v, i) => `${f(px(i))},${f(py(v))}`);
  const area = `M${f(px(0))},${h - pad} L${pts.join(' L')} L${f(px(n - 1))},${h - pad}Z`;
  const ex = px(n - 1), ey = py(values[n - 1] ?? 0);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${area}" fill="#2a78d6" fill-opacity=".1"/><polyline points="${pts.join(' ')}" fill="none" class="s-blue" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${f(ex)}" cy="${f(ey)}" r="5.5" class="ring"/><circle cx="${f(ex)}" cy="${f(ey)}" r="3.5" class="f-blue"/></svg>`;
}

/** Small "x of y" bar used in table rows. */
export function meter(part: number, total: number, w = 76, h = 8): string {
  if (total <= 0) return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect width="${w}" height="${h}" rx="4" class="f-h0"/></svg>`;
  const fill = Math.max(0, Math.min(1, part / total)) * w;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect width="${w}" height="${h}" rx="4" class="f-track"/>${fill > 0 ? `<path d="${barPath(0, 0, Math.max(fill, 4), h, true)}" class="f-blue"/>` : ''}</svg>`;
}

export interface Segment {
  cls: 'f-good' | 'f-warn' | 'f-crit' | 'f-neutral' | 'f-blue';
  value: number;
  tip: string;
}

/** Part-to-whole in one horizontal bar, 2px surface gaps between segments. */
export function stackedBar(segments: Segment[], w = 640, h = 20): string {
  const live = segments.filter((s) => s.value > 0);
  const total = live.reduce((s, x) => s + x.value, 0);
  if (total === 0) return `<svg viewBox="0 0 ${w} ${h}" width="100%" aria-hidden="true"><rect width="${w}" height="${h}" rx="4" class="f-h0"/></svg>`;
  const gaps = (live.length - 1) * 2;
  let x = 0;
  const parts = live
    .map((s, i) => {
      const sw = ((w - gaps) * s.value) / total;
      const d = barPath(x, 0, sw, h, i === live.length - 1);
      const out = `<g class="seg" tabindex="0" data-tip="${esc(s.tip)}"><path class="hb ${s.cls}" d="${d}"/></g>`;
      x += sw + 2;
      return out;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="How enquiries ended">${parts}</svg>`;
}

/** Weekday x time-of-day heatmap (7 rows x 12 two-hour columns), one-hue sequential ramp. */
export function heatmap(grid: number[][], cellTip: (row: number, col: number, v: number) => string): string {
  const rows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cols = grid[0]?.length ?? 12;
  const cw = 38, ch = 24, gap = 3, L = 38, T = 22;
  const W = L + cols * (cw + gap), H = T + 7 * (ch + gap);
  const max = Math.max(1, ...grid.flat());
  const level = (v: number): number => (v <= 0 ? 0 : Math.min(6, Math.max(1, Math.ceil((v / max) * 6))));
  const hour = (c: number): string => { const h = c * 2; return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`; };
  const head = Array.from({ length: cols }, (_, c) => (c % 2 === 0 ? `<text class="tm" x="${L + c * (cw + gap) + cw / 2}" y="14" text-anchor="middle">${hour(c)}</text>` : '')).join('');
  const body = rows
    .map((name, r) => {
      const cells = (grid[r] ?? []).map((v, c) => `<rect class="cell f-h${level(v)}" x="${L + c * (cw + gap)}" y="${T + r * (ch + gap)}" width="${cw}" height="${ch}" rx="4" tabindex="0" data-tip="${esc(cellTip(r, c, v))}"/>`).join('');
      return `<text class="t" x="${L - 8}" y="${T + r * (ch + gap) + ch / 2 + 4}" text-anchor="end">${name}</text>${cells}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="When enquiries arrive, by weekday and time of day">${head}${body}</svg>`;
}

export interface HBar {
  label: string;
  value: number;
  display: string;
  tip: string;
}

/** Ranked horizontal bars with the value at the tip. One hue (emphasis on the biggest). */
export function hbars(items: HBar[], w = 560): string {
  if (items.length === 0) return '';
  const rowH = 36, bh = 16, L = 176, R = 78;
  const H = items.length * rowH + 4;
  const max = Math.max(1, ...items.map((i) => i.value));
  const rows = items
    .map((it, i) => {
      const y = i * rowH + 6, bw = Math.max(4, ((w - L - R) * it.value) / max);
      const name = it.label.length > 26 ? `${it.label.slice(0, 25)}…` : it.label;
      return `<g class="col" tabindex="0" data-tip="${esc(it.tip)}"><rect class="hit" x="0" y="${y - 4}" width="${w}" height="${rowH - 2}"/><text class="t" x="0" y="${y + bh - 3}">${esc(name)}</text><path class="hb ${i === 0 ? 'f-blue' : 'f-h3'}" d="${barPath(L, y, bw, bh, true)}"/><text class="tv" x="${f(L + bw + 8)}" y="${y + bh - 3}">${esc(it.display)}</text></g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${H}" width="100%" role="img" aria-label="Top customers by draft quote value">${rows}</svg>`;
}

export type IconKind = 'good' | 'warn' | 'crit' | 'neutral';

/** Status icons: shape differs by state, so colour is never the only signal. */
export function statusIcon(kind: IconKind, size = 14): string {
  const s = `width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true"`;
  switch (kind) {
    case 'good':
      return `<svg ${s}><circle cx="7" cy="7" r="7" class="f-good"/><path d="M3.7 7.2l2.2 2.2 4.4-4.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'warn':
      return `<svg ${s}><path d="M7 .8l6.4 11.4H.6z" class="f-warn" stroke-linejoin="round"/><path d="M7 5v3.4M7 10.2v.1" stroke="#3a2a00" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    case 'crit':
      return `<svg ${s}><circle cx="7" cy="7" r="7" class="f-crit"/><path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    default:
      return `<svg ${s}><circle cx="7" cy="7" r="7" class="f-neutral"/><path d="M4 7h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  }
}
