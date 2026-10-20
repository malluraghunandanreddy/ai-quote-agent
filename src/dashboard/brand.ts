import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config';
import { CSS } from './theme';

/**
 * White-labelling: the dashboard can carry a different name, logo, accent colour and footer line per deployment, from
 * settings alone (BRAND_*), so one codebase serves "our" product and a client's own branded one. Data colours in the
 * charts are NOT affected: they come from a separately validated palette and stay the same whatever the accent is.
 */

export interface Brand {
  name: string;
  /** Address of the logo image, or null when none is set. */
  logoUrl: string | null;
  /** Show only the logo, not the name next to it (for a logo that already contains the name). */
  logoOnly: boolean;
  footer: string | null;
  cssHref: string;
  faviconHref: string;
}

const DEFAULT_ACCENT = '#2a78d6';
const hash = (s: string | Buffer): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}
const toHex = (c: Rgb): string => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function luminance([r, g, b]: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrastWithWhite = (c: Rgb): number => 1.05 / (luminance(c) + 0.05);

/**
 * The four accent tokens the interface uses. Buttons carry white text, so a colour too light for that is darkened
 * until it reads clearly (WCAG 4.5:1); the deep, wash and line tones are derived from it.
 */
export function accentTokens(hex: string): { brand: string; deep: string; wash: string; line: string } {
  let c = parseHex(hex);
  for (let i = 0; i < 30 && contrastWithWhite(c) < 4.5; i++) c = mix(c, BLACK, 0.06);
  return { brand: toHex(c), deep: toHex(mix(c, BLACK, 0.28)), wash: toHex(mix(c, WHITE, 0.9)), line: toHex(mix(c, WHITE, 0.78)) };
}

const faviconFor = (hex: string): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${hex}"/><path d="M9 16.5l5 5 9-10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const LOGO_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_LOGO_BYTES = 1024 * 1024;

export interface LoadedBrand {
  brand: Brand;
  /** The stylesheet to serve: the design plus this brand's accent. */
  css: string;
  logo: { body: Buffer; type: string } | null;
  /** Things in the settings that were ignored, for the log. */
  warnings: string[];
}

export const DEFAULT_BRAND: Brand = {
  name: 'Quote assistant',
  logoUrl: null,
  logoOnly: false,
  footer: null,
  cssHref: `/assets/app.css?v=${hash(CSS)}`,
  faviconHref: faviconFor(DEFAULT_ACCENT),
};

/** Read the BRAND_* settings. A bad logo or colour is skipped with a warning; it never stops the dashboard from starting. */
export function loadBrand(cfg: Config['brand'] | undefined): LoadedBrand {
  if (!cfg) return { brand: DEFAULT_BRAND, css: CSS, logo: null, warnings: [] };
  const warnings: string[] = [];

  let css = CSS;
  let favicon = DEFAULT_BRAND.faviconHref;
  if (cfg.color) {
    const t = accentTokens(cfg.color);
    css += `:root{--brand:${t.brand};--brand-deep:${t.deep};--brand-wash:${t.wash};--brand-line:${t.line}}`;
    favicon = faviconFor(t.brand);
    if (t.brand !== cfg.color.toLowerCase()) warnings.push(`BRAND_COLOR ${cfg.color} is too light for white button text, so ${t.brand} is used instead`);
  }

  let logo: LoadedBrand['logo'] = null;
  if (cfg.logoPath) {
    try {
      const file = path.resolve(cfg.logoPath);
      const type = LOGO_TYPES[path.extname(file).toLowerCase()];
      if (!type) throw new Error('use a .png, .jpg, .gif, .webp or .svg file');
      const body = fs.readFileSync(file);
      if (body.length === 0 || body.length > MAX_LOGO_BYTES) throw new Error(`the file must be between 1 byte and ${MAX_LOGO_BYTES / 1024} KB`);
      if (type === 'image/svg+xml') {
        const text = body.toString('utf8');
        if (!/<svg[\s>]/i.test(text)) throw new Error('that is not an SVG file');
        if (/<script|\son\w+\s*=|javascript:/i.test(text)) throw new Error('the SVG contains script, which is not allowed');
      }
      logo = { body, type };
    } catch (err) {
      warnings.push(`BRAND_LOGO ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const brand: Brand = {
    name: cfg.name,
    logoUrl: logo ? `/assets/logo?v=${hash(logo.body)}` : null,
    logoOnly: cfg.logoOnly && logo !== null,
    footer: cfg.footer ?? null,
    cssHref: `/assets/app.css?v=${hash(css)}`,
    faviconHref: favicon,
  };
  return { brand, css, logo, warnings };
}
