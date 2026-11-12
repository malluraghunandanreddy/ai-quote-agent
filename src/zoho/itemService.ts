import { nameKey, skuKey } from '../excel/normalizer';
import { logger } from '../logger';
import type { ItemMatch, ZohoApi, ZohoItem } from '../types';

const DEFAULT_TTL_MS = 10 * 60_000;

function addTo(map: Map<string, ZohoItem[]>, key: string, item: ZohoItem): void {
  if (key === '') return;
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/**
 * Item Master lookup: SKU first, then exact normalized name. Both are exact comparisons done in code against the
 * active Zoho item list (cached, refreshed every few minutes) so one enquiry costs no per-line API calls and a
 * fuzzy search result can never be mistaken for a match. A SKU or name shared by several items is reported as
 * AMBIGUOUS rather than guessed.
 */
export class ItemCatalog {
  private bySku = new Map<string, ZohoItem[]>();
  private byName = new Map<string, ZohoItem[]>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private count = 0;
  private active: ZohoItem[] = [];

  constructor(
    private readonly api: ZohoApi,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.count;
  }

  /** The active items as loaded (for the AI's help with wording the exact rules cannot match). */
  activeItems(): ZohoItem[] {
    return this.active;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loadedAt > 0 && this.clock() - this.loadedAt < this.ttlMs) return;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const items = await this.api.getAllPages<ZohoItem>('/items', 'items', { filter_by: 'Status.Active' });
    const bySku = new Map<string, ZohoItem[]>();
    const byName = new Map<string, ZohoItem[]>();
    let count = 0;
    for (const item of items) {
      if (item.status !== undefined && item.status !== 'active') continue;
      count++;
      if (item.sku) addTo(bySku, skuKey(item.sku), item);
      addTo(byName, nameKey(item.name), item);
    }
    this.bySku = bySku;
    this.byName = byName;
    this.count = count;
    this.active = items.filter((i) => i.status === undefined || i.status === 'active');
    this.loadedAt = this.clock();
    logger.info('Zoho item master loaded', { activeItems: count });
  }

  match(line: { sku: string | null; description: string }): ItemMatch {
    if (line.sku) {
      const hits = this.bySku.get(skuKey(line.sku));
      if (hits?.length === 1 && hits[0]) return { status: 'matched', by: 'sku', item: hits[0] };
      if (hits && hits.length > 1) return { status: 'unmatched', reason: 'AMBIGUOUS' };
    }
    const hits = this.byName.get(nameKey(line.description));
    if (hits?.length === 1 && hits[0]) return { status: 'matched', by: 'name', item: hits[0] };
    if (hits && hits.length > 1) return { status: 'unmatched', reason: 'AMBIGUOUS' };
    return { status: 'unmatched', reason: 'NOT_FOUND' };
  }
}
