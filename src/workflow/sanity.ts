import type { RfqLine } from '../types';

export type ReviewFlag = 'LARGE_QUANTITY' | 'LARGE_TOTAL' | 'FRACTIONAL_UNITS' | 'DUPLICATE_ITEM';

export interface ReviewFinding {
  flag: ReviewFlag;
  /** Plain-language warning for Sales, shown on the notification and the dashboard. */
  message: string;
}

export interface ReviewLimits {
  warnQuantityAbove: number;
  warnTotalAbove: number;
}

/** Whole-item units: a quantity of 2.5 "pcs" is almost certainly a typo or a misread decimal. */
const COUNTED_UNITS = new Set(['pcs', 'box', 'dz']);
const MAX_LISTED = 5;

const num = (n: number): string => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);

function rows(list: number[]): string {
  const shown = list.slice(0, MAX_LISTED).join(', ');
  return list.length > MAX_LISTED ? `${shown} and ${list.length - MAX_LISTED} more` : shown;
}

/**
 * Cheap deterministic checks run on every draft. They never block a quote (a draft is safe: nothing is sent), they
 * make sure a person looks before it goes out. Pure function: no I/O.
 */
export function reviewFindings(lines: RfqLine[], total: number, currency: string, limits: ReviewLimits): ReviewFinding[] {
  const out: ReviewFinding[] = [];

  const large = lines.filter((l) => l.quantity > limits.warnQuantityAbove);
  if (large.length > 0) {
    out.push({
      flag: 'LARGE_QUANTITY',
      message: `Unusually large quantity on row ${rows(large.map((l) => l.rowNumber))} (up to ${num(Math.max(...large.map((l) => l.quantity)))}, above the ${num(limits.warnQuantityAbove)} limit). Check it is not a typo before sending.`,
    });
  }

  if (total > limits.warnTotalAbove) {
    out.push({
      flag: 'LARGE_TOTAL',
      message: `The quote total ${currency} ${num(total)} is unusually large (above ${num(limits.warnTotalAbove)}). Check quantities and prices before sending.`,
    });
  }

  const fractional = lines.filter((l) => l.uom !== null && COUNTED_UNITS.has(l.uom) && !Number.isInteger(l.quantity));
  if (fractional.length > 0) {
    out.push({
      flag: 'FRACTIONAL_UNITS',
      message: `A fractional quantity for a counted unit on row ${rows(fractional.map((l) => l.rowNumber))} (for example ${num(fractional[0]!.quantity)} ${fractional[0]!.uom}). Check the quantity.`,
    });
  }

  const bySku = new Map<string, number[]>();
  for (const l of lines) {
    if (!l.sku) continue;
    const key = l.sku.toLowerCase();
    bySku.set(key, [...(bySku.get(key) ?? []), l.rowNumber]);
  }
  const repeated = [...bySku.values()].filter((r) => r.length > 1);
  if (repeated.length > 0) {
    out.push({
      flag: 'DUPLICATE_ITEM',
      message: `The same item code appears on more than one row (rows ${repeated.slice(0, 3).map((r) => r.join(' and ')).join('; ')}). Both lines were kept; merge them if they are the same request.`,
    });
  }
  return out;
}
