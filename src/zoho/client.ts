import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import type { ZohoConfig } from '../config';
import { logger } from '../logger';
import type { ZohoApi } from '../types';

type Params = Record<string, string | number | boolean | undefined>;

export class ZohoApiError extends Error {
  constructor(
    message: string,
    readonly info: {
      status?: number | undefined;
      zohoCode?: number | undefined;
      /** Worth retrying later (network, throttling, Zoho outage). */
      transient: boolean;
      /** A POST that may or may not have been applied by Zoho (timeout / 5xx). Check before re-sending. */
      outcomeUnknown?: boolean | undefined;
    },
  ) {
    super(message);
    this.name = 'ZohoApiError';
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  expires_in_sec?: number;
  error?: string;
}

const TOKEN_SAFETY_MARGIN_MS = 60_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 100;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Zoho Books REST client (API v3) with automatic OAuth2 access-token refresh.
 *
 *  - The access token is cached and refreshed from the long-lived refresh token against
 *    {accounts}/oauth/v2/token shortly before it expires, or once on a 401. Concurrent callers share one refresh
 *    (Zoho rate-limits token refreshes).
 *  - GETs retry on network errors, 429 and 5xx. POSTs retry only when Zoho clearly did NOT process the call
 *    (401 after refresh, 429); a timeout or 5xx on a POST is surfaced as `outcomeUnknown` so the caller can look
 *    the record up instead of risking a duplicate.
 */
export class ZohoClient implements ZohoApi {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly cfg: ZohoConfig,
    private readonly http: AxiosInstance = axios.create({ timeout: 30_000 }),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_SAFETY_MARGIN_MS) return this.token.value;
    this.refreshing ??= this.refreshAccessToken().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: this.cfg.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: 'refresh_token',
    });
    let res: AxiosResponse<TokenResponse>;
    try {
      res = await this.http.post<TokenResponse>(`${this.cfg.accountsUrl}/oauth/v2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      });
    } catch (err) {
      throw new ZohoApiError(`Zoho token refresh failed: ${(err as Error).message}`, { transient: true });
    }
    // Zoho reports OAuth failures as HTTP 200 with an "error" field.
    const data = res.data ?? {};
    if (!data.access_token) {
      throw new ZohoApiError(`Zoho token refresh failed: ${data.error ?? `HTTP ${res.status}`}`, {
        status: res.status,
        transient: res.status >= 500 || res.status === 429,
      });
    }
    const raw = data.expires_in_sec ?? data.expires_in ?? 3600;
    const seconds = raw >= 100_000 ? raw / 1000 : raw; // some data centres report milliseconds
    this.token = { value: data.access_token, expiresAt: Date.now() + seconds * 1000 };
    logger.debug('Zoho access token refreshed', { validForSeconds: Math.round(seconds) });
    return this.token.value;
  }

  /** Drop the cached token if it is still the one that just got rejected. */
  private invalidate(rejected: string): void {
    if (this.token?.value === rejected) this.token = null;
  }

  async get<T = unknown>(path: string, params?: Params): Promise<T> {
    return this.request<T>('GET', path, params);
  }

  async post<T = unknown>(path: string, body: unknown, params?: Params): Promise<T> {
    return this.request<T>('POST', path, params, body);
  }

  async getAllPages<T = unknown>(path: string, key: string, params?: Params): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.get<Record<string, unknown>>(path, { ...params, page, per_page: PAGE_SIZE });
      const rows = res[key];
      if (Array.isArray(rows)) all.push(...(rows as T[]));
      const ctx = res.page_context as { has_more_page?: boolean } | undefined;
      if (!ctx?.has_more_page) return all;
    }
    throw new ZohoApiError(`Zoho ${path}: more than ${MAX_PAGES} pages; refusing to continue`, { transient: false });
  }

  private async request<T>(method: 'GET' | 'POST', path: string, params?: Params, data?: unknown): Promise<T> {
    const maxRetries = this.cfg.httpRetries;
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.getAccessToken();
      let res: AxiosResponse;
      try {
        res = await this.http.request({
          method,
          url: `${this.cfg.apiBase}${path}`,
          params: { ...params, organization_id: this.cfg.organizationId },
          ...(data !== undefined ? { data } : {}),
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          validateStatus: () => true,
        });
      } catch (err) {
        if (method === 'GET' && attempt < maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new ZohoApiError(`Zoho request ${method} ${path} failed: ${(err as Error).message}`, {
          transient: true,
          outcomeUnknown: method === 'POST',
        });
      }

      if (res.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.invalidate(token);
        logger.debug('Zoho returned 401; refreshing the access token once');
        continue;
      }
      const throttled = res.status === 429;
      const serverError = res.status >= 500;
      if ((throttled || (serverError && method === 'GET')) && attempt < maxRetries) {
        await this.sleep(this.retryDelay(res, attempt));
        continue;
      }

      const body = (res.data ?? {}) as { code?: number; message?: string };
      if (res.status >= 200 && res.status < 300 && (body.code === undefined || body.code === 0)) return res.data as T;

      throw new ZohoApiError(`Zoho Books ${method} ${path} -> ${res.status}: ${body.message ?? 'request failed'}`, {
        status: res.status,
        zohoCode: body.code,
        transient: throttled || serverError,
        outcomeUnknown: method === 'POST' && serverError,
      });
    }
  }

  private backoff(attempt: number): number {
    return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  private retryDelay(res: AxiosResponse, attempt: number): number {
    const header = Number(res.headers?.['retry-after']);
    return Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 30_000) : this.backoff(attempt);
  }
}
