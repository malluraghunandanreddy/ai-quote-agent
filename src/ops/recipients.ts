import { z } from 'zod';
import type { Config } from '../config';
import type { Repository } from '../db/repository';

/**
 * Who hears about what. The settings file gives the starting addresses; the owner can change them from the dashboard, and
 * what they save here wins. Sales gets the "additional information", "draft created", "customer not found", failure and daily
 * summary emails; the stakeholders get the "new/unmatched products" email.
 */
export interface AlertRecipients {
  sales: string[];
  stakeholders: string[];
  /** True when the owner has saved their own lists in the dashboard; false while the settings file's addresses are in use. */
  fromDashboard: boolean;
}

const KEY = 'alert_recipients';
export const MAX_ADDRESSES = 10;

const isEmail = (s: string): boolean => z.email().safeParse(s).success;

export function defaultRecipients(config: Config): AlertRecipients {
  return { sales: [config.notify.internal], stakeholders: [...config.notify.stakeholders], fromDashboard: false };
}

export function effectiveRecipients(repo: Pick<Repository, 'getMeta'>, config: Config): AlertRecipients {
  const raw = repo.getMeta(KEY);
  if (raw) {
    try {
      const v = JSON.parse(raw) as { sales?: unknown; stakeholders?: unknown };
      const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((a): a is string => typeof a === 'string' && isEmail(a)) : []);
      const sales = list(v.sales);
      const stakeholders = list(v.stakeholders);
      if (sales.length > 0 && stakeholders.length > 0) return { sales, stakeholders, fromDashboard: true };
    } catch {
      // a damaged value falls back to the settings file's addresses
    }
  }
  return defaultRecipients(config);
}

/** "a@x.co, b@x.co" or one per line -> a clean, lower-case, de-duplicated list. */
export function parseAddressList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))];
}

export interface CheckContext {
  config: Config;
  /** True when this address has ever written to us as a customer. */
  isCustomerAddress: (address: string) => boolean;
}

/**
 * What is wrong with these lists, in plain words (empty = fine). The assistant must never email a customer, so an address
 * is refused when it is not on the client's own domains (if the operator set any), or when it has written to us as a customer
 * (the addresses from the settings file are exempt: the operator chose those).
 */
export function checkRecipients(lists: { sales: string[]; stakeholders: string[] }, ctx: CheckContext): string[] {
  const problems: string[] = [];
  const own = new Set([ctx.config.notify.internal, ...ctx.config.notify.stakeholders, ctx.config.notify.from.match(/<([^>]+)>/)?.[1] ?? ctx.config.notify.from].map((a) => a.toLowerCase()));
  const domains = new Set(ctx.config.notify.allowedDomains.map((d) => d.toLowerCase()));
  for (const [name, list] of [['Sales', lists.sales], ['Stakeholders', lists.stakeholders]] as const) {
    if (list.length === 0) problems.push(`${name}: add at least one email address.`);
    if (list.length > MAX_ADDRESSES) problems.push(`${name}: at most ${MAX_ADDRESSES} addresses.`);
    for (const address of list) {
      if (!isEmail(address) || address.length > 120) {
        problems.push(`${name}: "${address.slice(0, 60)}" is not a valid email address.`);
        continue;
      }
      if (own.has(address)) continue;
      if (domains.size > 0 && !domains.has(address.split('@')[1] ?? '')) problems.push(`${name}: ${address} is not on your company's email domain (${[...domains].join(', ')}). Alerts only go to your own team.`);
      else if (ctx.isCustomerAddress(address)) problems.push(`${name}: ${address} has written to you as a customer. Alerts only go to your own team, never to customers.`);
    }
  }
  return problems;
}

export function saveRecipients(repo: Pick<Repository, 'setMeta'>, lists: { sales: string[]; stakeholders: string[] }): void {
  repo.setMeta(KEY, JSON.stringify({ sales: lists.sales, stakeholders: lists.stakeholders }));
}

/** Go back to the settings file's addresses. */
export function resetRecipients(repo: Pick<Repository, 'setMeta'>): void {
  repo.setMeta(KEY, '');
}
