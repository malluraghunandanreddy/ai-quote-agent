import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * All configuration is read from environment variables (see .env.example), validated once with Zod,
 * and exposed as a typed, nested, read-only object. Nothing else in the code base touches process.env.
 */

const DEFAULT_INBOX = 'quotes@demo.example.com';

/** Free-mail domains that never identify a company, so they are never used for domain matching. */
const DEFAULT_PUBLIC_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'zohomail.com', 'zohomail.in',
  'rediffmail.com', 'mail.com', 'gmx.com', 'gmx.net', 'yandex.com', 'yandex.ru', 'qq.com', '163.com',
  '126.com', 'fastmail.com', 'tutanota.com', 'inbox.com',
];

const ZOHO_DATA_CENTRES = ['com', 'in', 'eu', 'com.au', 'jp', 'ca', 'sa', 'com.cn'] as const;

// --- small schema helpers: an empty string in .env means "not set" -----------------------------
const blankToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const str = () => z.preprocess(blankToUndefined, z.string().trim().optional());
const strDefault = (d: string) => z.preprocess(blankToUndefined, z.string().trim().default(d));
const int = (d: number, min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(d));
const bool = (d: boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : blankToUndefined(v)),
    z.enum(['true', 'false', '1', '0', 'yes', 'no']).transform((v) => v === 'true' || v === '1' || v === 'yes').default(d),
  );
const csv = () =>
  z.preprocess(
    blankToUndefined,
    z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).default([]),
  );

const EnvSchema = z
  .object({
    LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
    AGENT_DB_PATH: strDefault('data/quote-agent.sqlite'),
    QUOTE_TIMEZONE: strDefault('Asia/Kolkata'),

    // Mailbox (IMAP over TLS)
    MONITORED_INBOX: strDefault(DEFAULT_INBOX),
    IMAP_HOST: str(),
    IMAP_PORT: int(993, 1, 65535),
    IMAP_USER: str(),
    IMAP_PASSWORD: str(),
    IMAP_FOLDER: strDefault('INBOX'),
    IMAP_PROCESSED_FOLDER: str(),
    // Optional: only act on unread mail addressed to this address (e.g. quotes+rfq@gmail.com). Other mail is left untouched.
    IMAP_ONLY_TO: str(),
    IMAP_BATCH_LIMIT: int(25, 1, 500),
    POLL_CRON: strDefault('*/2 * * * *'),
    RUN_ON_START: bool(true),

    // Outbound mail
    SMTP_HOST: str(),
    SMTP_PORT: int(587, 1, 65535),
    SMTP_USER: str(),
    SMTP_PASSWORD: str(),
    SMTP_FROM: str(),
    SMTP_STARTTLS: bool(true),
    SALES_TEAM_EMAIL: str(),
    NOTIFY_INTERNAL_EMAIL: str(),
    EXCEPTION_STAKEHOLDERS: csv(),

    // Zoho Books
    ZOHO_DC: z.preprocess(blankToUndefined, z.enum(ZOHO_DATA_CENTRES).default('in')),
    ZOHO_CLIENT_ID: str(),
    ZOHO_CLIENT_SECRET: str(),
    ZOHO_REFRESH_TOKEN: str(),
    ZOHO_ORGANIZATION_ID: str(),
    ZOHO_ACCOUNTS_URL: str(),
    ZOHO_API_BASE: str(),
    ZOHO_HTTP_RETRIES: int(2, 0, 10),
    ZOHO_QUOTE_LINK_PATH: z.preprocess(blankToUndefined, z.enum(['quotes', 'estimates']).default('quotes')),
    ZOHO_SEND_ITEM_RATE: bool(false),
    ITEM_AI_MATCH: z.preprocess(blankToUndefined, z.enum(['off', 'suggest', 'link']).default('link')),
    ESTIMATE_VALIDITY_DAYS: int(30, 1, 365),

    // LLM: Anthropic Claude Haiku. Optional: without a key the rules-only fallbacks run.
    // (AI_PROVIDER, GEMINI_*, AI_MODEL and AI_EFFORT in a shared .env belong to the Python app and are ignored here.)
    ANTHROPIC_API_KEY: str(),
    ANTHROPIC_MODEL: strDefault('claude-haiku-5-5'),
    ANTHROPIC_EFFORT: z.preprocess(blankToUndefined, z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low')),
    LLM_ENABLED: z.preprocess(blankToUndefined, z.enum(['auto', 'true', 'false']).default('auto')),
    // USD per 1M tokens, used only for the cost estimate in the logs (Haiku 5.5 list price, prompts up to 100K tokens)
    ANTHROPIC_PRICE_IN_PER_MTOK: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(0.1)),
    ANTHROPIC_PRICE_OUT_PER_MTOK: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(0.5)),
    AI_TIMEOUT_MS: int(30_000, 1_000, 600_000),
    // Safety net against a flood of mail burning credits: after this many model calls in an hour the rules-only path runs
    LLM_MAX_CALLS_PER_HOUR: int(600, 1, 1_000_000),
    AI_MAX_RETRIES: int(2, 0, 5),

    // New customers: keep their first email and make the quote automatically once they are added in Zoho Books
    HOLD_NEW_CUSTOMER_DAYS: int(7, 0, 60),
    // Optional: the client's own email domains. When set, the dashboard only accepts alert addresses on these domains.
    ALERT_ALLOWED_DOMAINS: csv(),
    HOLD_CHECK_MINUTES: int(30, 1, 240),
    HOLD_MAX_EMAILS: int(50, 1, 500),

    // Idempotency and limits
    DEDUPE_WINDOW_HOURS: int(48, 1, 24 * 30),
    MAX_ATTEMPTS: int(5, 1, 50),
    STALE_PROCESSING_MINUTES: int(15, 1, 24 * 60),
    MAX_ATTACHMENT_MB: int(15, 1, 100),
    MAX_EXCEL_ROWS: int(2000, 10, 100_000),
    PUBLIC_EMAIL_DOMAINS: csv(),

    // Dashboard (read-only web page). Without a password only /healthz is served.
    CLIENT_NAME: strDefault(''),
    BRAND_NAME: strDefault('Quote assistant'),
    BRAND_LOGO: str(),
    BRAND_LOGO_ONLY: bool(false),
    BRAND_COLOR: str(),
    BRAND_FOOTER: str(),
    SHOW_AI_COST: bool(false),
    DASHBOARD_PASSWORD: str(),
    DASHBOARD_OWNER_EMAIL: str(),
    DASHBOARD_HOST: strDefault('127.0.0.1'),
    DASHBOARD_PORT: int(3000, 1, 65535),
    DASHBOARD_TRUST_PROXY: bool(false),
    PUBLIC_DASHBOARD_URL: str(),

    // Backups, retention, monitoring
    BACKUP_DIR: strDefault('data/backups'),
    BACKUP_KEEP: int(14, 1, 365),
    BACKUP_CRON: strDefault('0 2 * * *'),
    RETENTION_DAYS: int(365, 7, 3650),
    DAILY_SUMMARY_CRON: strDefault('0 8 * * *'),
    ALERT_AFTER_FAILURES: int(3, 1, 100),
    HEALTH_STALE_MINUTES: int(15, 2, 1440),

    // Review flags and the "time saved" estimate
    WARN_QUANTITY_ABOVE: z.preprocess(blankToUndefined, z.coerce.number().positive().default(100_000)),
    WARN_TOTAL_ABOVE: z.preprocess(blankToUndefined, z.coerce.number().positive().default(5_000_000)),
    MANUAL_MINUTES_PER_ENQUIRY: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(10)),
    MANUAL_MINUTES_PER_LINE: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(2)),
    // What an hour of the client's quoting staff costs them, in the quote currency. Optional: turns hours saved into money.
    STAFF_COST_PER_HOUR: z.preprocess(blankToUndefined, z.coerce.number().positive().optional()),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    const zoho = [env.ZOHO_CLIENT_ID, env.ZOHO_CLIENT_SECRET, env.ZOHO_REFRESH_TOKEN, env.ZOHO_ORGANIZATION_ID];
    if (zoho.some(Boolean) && !zoho.every(Boolean)) {
      for (const [name, value] of Object.entries({
        ZOHO_CLIENT_ID: env.ZOHO_CLIENT_ID,
        ZOHO_CLIENT_SECRET: env.ZOHO_CLIENT_SECRET,
        ZOHO_REFRESH_TOKEN: env.ZOHO_REFRESH_TOKEN,
        ZOHO_ORGANIZATION_ID: env.ZOHO_ORGANIZATION_ID,
      })) {
        if (!value) issue(name, 'required when any other ZOHO_* credential is set');
      }
    }
    if (env.IMAP_HOST) {
      if (!env.IMAP_PASSWORD) issue('IMAP_PASSWORD', 'required when IMAP_HOST is set');
    }
    if (env.SMTP_HOST) {
      if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
        issue('SMTP_PASSWORD', 'SMTP_USER and SMTP_PASSWORD must be set together');
      }
    }
    const emails: Array<[string, string[]]> = [
      ['MONITORED_INBOX', [env.MONITORED_INBOX]],
      ['SALES_TEAM_EMAIL', env.SALES_TEAM_EMAIL ? [env.SALES_TEAM_EMAIL] : []],
      ['NOTIFY_INTERNAL_EMAIL', env.NOTIFY_INTERNAL_EMAIL ? [env.NOTIFY_INTERNAL_EMAIL] : []],
      ['SMTP_FROM', env.SMTP_FROM ? [env.SMTP_FROM] : []],
      ['IMAP_ONLY_TO', env.IMAP_ONLY_TO ? [env.IMAP_ONLY_TO] : []],
      ['EXCEPTION_STAKEHOLDERS', env.EXCEPTION_STAKEHOLDERS],
    ];
    for (const [name, list] of emails) {
      for (const address of list) {
        if (!z.email().safeParse(address).success) issue(name, `"${address}" is not a valid email address`);
      }
    }
    if (env.DASHBOARD_PASSWORD && env.DASHBOARD_PASSWORD.length < 10) {
      issue('DASHBOARD_PASSWORD', 'must be at least 10 characters (it protects customer and quote information)');
    }
    if (env.BRAND_COLOR && !/^#[0-9a-fA-F]{6}$/.test(env.BRAND_COLOR)) {
      issue('BRAND_COLOR', 'must be a hex colour like #0f7b6c (six digits)');
    }
    if (env.BRAND_NAME.length > 60) issue('BRAND_NAME', 'must be 60 characters or fewer');
    if (env.BRAND_FOOTER && env.BRAND_FOOTER.length > 160) issue('BRAND_FOOTER', 'must be 160 characters or fewer');
    if (env.DASHBOARD_OWNER_EMAIL && !/^[^\s@]+@[^\s@]+$/.test(env.DASHBOARD_OWNER_EMAIL)) {
      issue('DASHBOARD_OWNER_EMAIL', 'must be an email address');
    }
    if (env.PUBLIC_DASHBOARD_URL && !/^https?:\/\/\S+$/.test(env.PUBLIC_DASHBOARD_URL)) {
      issue('PUBLIC_DASHBOARD_URL', 'must start with http:// or https://');
    }
    // Claude settings are validated whenever a key is present or the LLM is forced on.
    if (env.ANTHROPIC_API_KEY || env.LLM_ENABLED === 'true') {
      if (env.ANTHROPIC_API_KEY && /\s/.test(env.ANTHROPIC_API_KEY)) issue('ANTHROPIC_API_KEY', 'must not contain whitespace');
      if (env.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
        issue('ANTHROPIC_API_KEY', 'does not look like an Anthropic secret key (they start with "sk-ant-"). Did you copy the key ID ("apikey_...") instead of the secret shown once when the key was created?');
      }
      if (!/^[\w.-]+$/.test(env.ANTHROPIC_MODEL)) issue('ANTHROPIC_MODEL', `"${env.ANTHROPIC_MODEL}" is not a valid model id`);
    }
    if (env.LLM_ENABLED === 'true' && !env.ANTHROPIC_API_KEY) issue('ANTHROPIC_API_KEY', 'required when LLM_ENABLED=true');
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: env.QUOTE_TIMEZONE });
    } catch {
      issue('QUOTE_TIMEZONE', `"${env.QUOTE_TIMEZONE}" is not a valid IANA timezone`);
    }
  });

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  folder: string;
  processedFolder: string | undefined;
  /** When set, only unread mail addressed (To or Cc) to exactly this address is processed; everything else stays untouched. */
  onlyTo: string | undefined;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = implicit TLS (port 465 style); false = STARTTLS upgrade (port 587 style) */
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

export interface ZohoConfig {
  dc: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizationId: string;
  /** e.g. https://accounts.zoho.in */
  accountsUrl: string;
  /** e.g. https://www.zohoapis.in/books/v3 */
  apiBase: string;
  /** e.g. https://books.zoho.in */
  appBase: string;
  httpRetries: number;
}

export interface Config {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  dbPath: string;
  timezone: string;
  monitoredInbox: string;
  imap: ImapConfig | null;
  imapBatchLimit: number;
  schedule: { cron: string; runOnStart: boolean };
  smtp: SmtpConfig | null;
  notify: { internal: string; stakeholders: string[]; from: string; allowedDomains: string[] };
  zoho: ZohoConfig | null;
  quote: { validityDays: number; linkPath: 'quotes' | 'estimates'; sendItemRate: boolean; itemAiMatch: 'off' | 'suggest' | 'link' };
  llm: {
    enabled: boolean;
    /** Why the LLM is off (null when enabled). Rules-only fallbacks run instead. */
    disabledReason: string | null;
    provider: 'anthropic';
    apiKey: string | undefined;
    model: string;
    /** Claude effort level; `low` is plenty for extraction and keeps cost and latency down. */
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** USD per 1M tokens; only feeds the cost estimate. */
    priceInPerMTok: number;
    priceOutPerMTok: number;
    timeoutMs: number;
    maxCallsPerHour: number;
    /** Retries after the first attempt (429 / 5xx / network), handled by the SDK. */
    maxRetries: number;
  };
  limits: {
    dedupeWindowHours: number;
    maxAttempts: number;
    staleProcessingMinutes: number;
    maxAttachmentBytes: number;
    maxExcelRows: number;
  };
  /** An email from a customer not yet in Zoho Books is kept this long (days; 0 = off) and re-checked this often. */
  hold: { days: number; checkMinutes: number; maxEmails: number };
  publicDomains: ReadonlySet<string>;
  dashboard: {
    clientName: string;
    /** The first owner's starting password. Used once, when nobody has a login yet; they must change it at first sign-in. */
    password: string | undefined;
    /** The first owner's email (their sign-in name). Falls back to the internal notification address. */
    ownerEmail: string | undefined;
    host: string;
    port: number;
    trustProxy: boolean;
    publicUrl: string | undefined;
    /** Show what the AI reading costs on the dashboard and in the daily summary email. Off by default. */
    showAiCost: boolean;
  };
  /** How the dashboard looks: whose name and logo, which accent colour. All optional. */
  brand: { name: string; logoPath: string | undefined; logoOnly: boolean; color: string | undefined; footer: string | undefined };
  backup: { dir: string; keep: number; cron: string };
  retentionDays: number;
  alerts: { dailySummaryCron: string | null; failuresBeforeAlert: number; staleMinutes: number };
  review: { warnQuantityAbove: number; warnTotalAbove: number };
  roi: { minutesPerEnquiry: number; minutesPerLine: number; staffCostPerHour: number | undefined };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validate an environment-like object and build the typed config. Pure: no I/O, easy to test. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  const e = parsed.data;

  const internal = e.NOTIFY_INTERNAL_EMAIL ?? e.SALES_TEAM_EMAIL ?? e.MONITORED_INBOX;
  const stakeholders = e.EXCEPTION_STAKEHOLDERS.length > 0 ? [...new Set(e.EXCEPTION_STAKEHOLDERS)] : [internal];

  const dc = e.ZOHO_DC;
  const zoho: ZohoConfig | null =
    e.ZOHO_CLIENT_ID && e.ZOHO_CLIENT_SECRET && e.ZOHO_REFRESH_TOKEN && e.ZOHO_ORGANIZATION_ID
      ? {
          dc,
          clientId: e.ZOHO_CLIENT_ID,
          clientSecret: e.ZOHO_CLIENT_SECRET,
          refreshToken: e.ZOHO_REFRESH_TOKEN,
          organizationId: e.ZOHO_ORGANIZATION_ID,
          accountsUrl: (e.ZOHO_ACCOUNTS_URL ?? `https://accounts.zoho.${dc}`).replace(/\/+$/, ''),
          apiBase: (e.ZOHO_API_BASE ?? `https://www.zohoapis.${dc}/books/v3`).replace(/\/+$/, ''),
          appBase: `https://books.zoho.${dc}`,
          httpRetries: e.ZOHO_HTTP_RETRIES,
        }
      : null;

  let llmDisabledReason: string | null = null;
  if (e.LLM_ENABLED === 'false') llmDisabledReason = 'LLM_ENABLED=false';
  else if (!e.ANTHROPIC_API_KEY) llmDisabledReason = 'ANTHROPIC_API_KEY is not set';

  return {
    logLevel: e.LOG_LEVEL,
    dbPath: e.AGENT_DB_PATH,
    timezone: e.QUOTE_TIMEZONE,
    monitoredInbox: e.MONITORED_INBOX,
    imap: e.IMAP_HOST
      ? {
          host: e.IMAP_HOST,
          port: e.IMAP_PORT,
          user: e.IMAP_USER ?? e.MONITORED_INBOX,
          password: e.IMAP_PASSWORD ?? '',
          folder: e.IMAP_FOLDER,
          processedFolder: e.IMAP_PROCESSED_FOLDER,
          onlyTo: e.IMAP_ONLY_TO?.toLowerCase(),
        }
      : null,
    imapBatchLimit: e.IMAP_BATCH_LIMIT,
    schedule: { cron: e.POLL_CRON, runOnStart: e.RUN_ON_START },
    smtp: e.SMTP_HOST
      ? {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: !e.SMTP_STARTTLS,
          user: e.SMTP_USER,
          password: e.SMTP_PASSWORD,
          from: e.SMTP_FROM ?? e.MONITORED_INBOX,
        }
      : null,
    notify: { internal, stakeholders, from: e.SMTP_FROM ?? e.MONITORED_INBOX, allowedDomains: [...new Set(e.ALERT_ALLOWED_DOMAINS.map((d) => d.toLowerCase()))] },
    zoho,
    quote: { validityDays: e.ESTIMATE_VALIDITY_DAYS, linkPath: e.ZOHO_QUOTE_LINK_PATH, sendItemRate: e.ZOHO_SEND_ITEM_RATE, itemAiMatch: e.ITEM_AI_MATCH },
    llm: {
      enabled: llmDisabledReason === null,
      disabledReason: llmDisabledReason,
      provider: 'anthropic',
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.ANTHROPIC_MODEL,
      effort: e.ANTHROPIC_EFFORT,
      priceInPerMTok: e.ANTHROPIC_PRICE_IN_PER_MTOK,
      priceOutPerMTok: e.ANTHROPIC_PRICE_OUT_PER_MTOK,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxCallsPerHour: e.LLM_MAX_CALLS_PER_HOUR,
      maxRetries: e.AI_MAX_RETRIES,
    },
    limits: {
      dedupeWindowHours: e.DEDUPE_WINDOW_HOURS,
      maxAttempts: e.MAX_ATTEMPTS,
      staleProcessingMinutes: e.STALE_PROCESSING_MINUTES,
      maxAttachmentBytes: e.MAX_ATTACHMENT_MB * 1024 * 1024,
      maxExcelRows: e.MAX_EXCEL_ROWS,
    },
    hold: { days: e.HOLD_NEW_CUSTOMER_DAYS, checkMinutes: e.HOLD_CHECK_MINUTES, maxEmails: e.HOLD_MAX_EMAILS },
    publicDomains: new Set([...DEFAULT_PUBLIC_DOMAINS, ...e.PUBLIC_EMAIL_DOMAINS.map((d) => d.toLowerCase())]),
    dashboard: {
      clientName: e.CLIENT_NAME,
      password: e.DASHBOARD_PASSWORD,
      ownerEmail: e.DASHBOARD_OWNER_EMAIL?.toLowerCase(),
      host: e.DASHBOARD_HOST,
      port: e.DASHBOARD_PORT,
      trustProxy: e.DASHBOARD_TRUST_PROXY,
      publicUrl: e.PUBLIC_DASHBOARD_URL?.replace(/\/+$/, ''),
      showAiCost: e.SHOW_AI_COST,
    },
    brand: { name: e.BRAND_NAME, logoPath: e.BRAND_LOGO, logoOnly: e.BRAND_LOGO_ONLY, color: e.BRAND_COLOR?.toLowerCase(), footer: e.BRAND_FOOTER },
    backup: { dir: e.BACKUP_DIR, keep: e.BACKUP_KEEP, cron: e.BACKUP_CRON },
    retentionDays: e.RETENTION_DAYS,
    alerts: {
      dailySummaryCron: /^(off|none|disabled|false)$/i.test(e.DAILY_SUMMARY_CRON) ? null : e.DAILY_SUMMARY_CRON,
      failuresBeforeAlert: e.ALERT_AFTER_FAILURES,
      staleMinutes: e.HEALTH_STALE_MINUTES,
    },
    review: { warnQuantityAbove: e.WARN_QUANTITY_ABOVE, warnTotalAbove: e.WARN_TOTAL_ABOVE },
    roi: { minutesPerEnquiry: e.MANUAL_MINUTES_PER_ENQUIRY, minutesPerLine: e.MANUAL_MINUTES_PER_LINE, staffCostPerHour: e.STAFF_COST_PER_HOUR },
  };
}

let cached: Config | undefined;

/** Load .env (once) and return the validated process-wide config. Throws ConfigError when invalid. */
export function getConfig(): Config {
  if (!cached) {
    dotenv.config({ quiet: true });
    cached = loadConfig(process.env);
  }
  return cached;
}

export function requireZoho(config: Config): ZohoConfig {
  if (!config.zoho) {
    throw new ConfigError(
      'Zoho Books is not configured: set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID.',
    );
  }
  return config.zoho;
}

export function requireImap(config: Config): ImapConfig {
  if (!config.imap) {
    throw new ConfigError('The mailbox is not configured: set IMAP_HOST, IMAP_USER and IMAP_PASSWORD.');
  }
  return config.imap;
}
