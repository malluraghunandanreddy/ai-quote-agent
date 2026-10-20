import type { CellValue } from 'exceljs';

/**
 * Deterministic cleaning of spreadsheet cells. Quantities, units and codes are NEVER produced by an LLM:
 * every number that reaches Zoho Books comes through these functions.
 */

export type RawCell = string | number | boolean | Date | null;

/** Unwrap exceljs' rich cell values (formulas, rich text, hyperlinks, errors) into a plain value. */
export function cellToRaw(value: CellValue | undefined): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if ('error' in v) return null;
    if ('result' in v) return cellToRaw(v.result as CellValue);
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
    }
    if ('text' in v) return cellToRaw(v.text as CellValue);
  }
  return null;
}

/** Cell as trimmed, single-spaced text ('' when empty). */
export function cellToText(value: CellValue | undefined): string {
  const raw = cellToRaw(value);
  if (raw === null) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw).replace(/\s+/g, ' ').trim();
}

/** Lower-case, punctuation-free header text: "Req. Qty" -> "req qty", "Part #" -> "part number". */
export function normalizeHeader(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "Qty (Nos)" -> "qty"
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Item code as text. Numeric cells (SAP material numbers) become plain integers, never "1.3e9". */
export function cleanSku(value: CellValue | undefined): string | null {
  const raw = cellToRaw(value);
  if (raw === null || raw instanceof Date || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Key for comparing SKUs: case-insensitive, whitespace-insensitive. Punctuation is significant. */
export function skuKey(sku: string): string {
  return sku.toLowerCase().replace(/\s+/g, '');
}

/** Key for exact normalized name comparison: case, accents, punctuation and spacing are ignored. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// --- quantities --------------------------------------------------------------------------------

export interface QuantityParse {
  /** null = nothing readable. May be zero or negative; the caller decides what to do with those. */
  value: number | null;
  /** Unit text that trailed the number ("1,200 Nos" -> "Nos"). */
  unitHint: string | null;
}

const PLAIN_NUMBER = /^(\d+(\.\d+)?|\.\d+)$/;
const INTERNATIONAL_GROUPING = /^\d{1,3}(,\d{3})+(\.\d+)?$/; // 1,200,000.5
const INDIAN_GROUPING = /^\d{1,2}(,\d{2})+,\d{3}(\.\d+)?$/; // 12,00,000.5
const QUANTITY_TEXT = /^([-+−]?)\s*(\d[\d.,]*|\.\d+)\s*([A-Za-z][A-Za-z./ ]{0,20})?$/;

/**
 * "1,200 Nos" -> 1200. Anything ambiguous ("2,5", "10-12", "approx 10", "1.200,50") returns value null so a
 * person is asked, rather than guessing a quantity.
 */
export function parseQuantity(value: CellValue | undefined): QuantityParse {
  const none: QuantityParse = { value: null, unitHint: null };
  const raw = cellToRaw(value);
  if (raw === null || raw instanceof Date || typeof raw === 'boolean') return none;
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, unitHint: null } : none;

  let text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return none;

  let negative = false;
  const accounting = /^\((.*)\)$/.exec(text); // (10) means -10
  if (accounting?.[1] !== undefined) {
    negative = true;
    text = accounting[1].trim();
  }

  const m = QUANTITY_TEXT.exec(text);
  if (!m) return none;
  const [, sign = '', numberToken = '', unit] = m;
  const token = numberToken.replace(/\.$/, '');
  const valid = PLAIN_NUMBER.test(token) || INTERNATIONAL_GROUPING.test(token) || INDIAN_GROUPING.test(token);
  if (!valid) return none;

  let n = Number(token.replace(/,/g, ''));
  if (!Number.isFinite(n)) return none;
  n = Math.round(n * 1e6) / 1e6;
  if (negative !== (sign === '-' || sign === '−')) n = -n;
  const unitHint = unit ? unit.replace(/\.$/, '').trim() : '';
  return { value: n, unitHint: unitHint === '' ? null : unitHint };
}

// --- units of measure --------------------------------------------------------------------------

/** Zoho Books' standard units: box, dz, ft, g, in, kg, km, lb, mg, ml, m, pcs. */
const UOM_GROUPS: Record<string, string[]> = {
  pcs: ['pcs', 'pc', 'piece', 'pieces', 'nos', 'no', 'number', 'numbers', 'each', 'ea', 'unit', 'units'],
  m: ['m', 'mtr', 'mtrs', 'meter', 'meters', 'metre', 'metres'],
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  g: ['g', 'gm', 'gms', 'gram', 'grams'],
  mg: ['mg', 'milligram', 'milligrams'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  ft: ['ft', 'feet', 'foot'],
  in: ['in', 'inch', 'inches'],
  km: ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'],
  ml: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
  box: ['box', 'boxes', 'bx'],
  dz: ['dz', 'doz', 'dozen', 'dozens'],
};

const UOM_LOOKUP = new Map<string, string>();
for (const [standard, aliases] of Object.entries(UOM_GROUPS)) {
  for (const alias of aliases) UOM_LOOKUP.set(alias, standard);
}

/** Map a unit as written ("Mtrs.", "NOS", "EA") to a Zoho Books standard unit; null when unknown (e.g. "PKT"). */
export function normalizeUom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return UOM_LOOKUP.get(raw.toLowerCase().replace(/[.\s]/g, '')) ?? null;
}

// --- junk rows ---------------------------------------------------------------------------------

const SUMMARY_LABEL =
  /^(grand\s*total|sub\s*-?\s*total|net\s*total|totals?|sum|total\s+(qty|quantity|amount|value|items?|price))\s*[:.-]?\s*$/i;

/** A totals row: the whole label is "Total" / "Grand Total" / ... (a product called "Total station" is not one). */
export function isSummaryLabel(text: string): boolean {
  return SUMMARY_LABEL.test(text.trim());
}
