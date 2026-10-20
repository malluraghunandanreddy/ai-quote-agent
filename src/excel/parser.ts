import ExcelJS from 'exceljs';
import type { ColumnMapping, ColumnResolver, ParseResult, RfqLine, SkippedRow } from '../types';
import { logger } from '../logger';
import {
  cellToRaw,
  cellToText,
  cleanSku,
  isSummaryLabel,
  normalizeHeader,
  normalizeUom,
  parseQuantity,
} from './normalizer';

type Field = 'sku' | 'description' | 'quantity' | 'uom';

/** Header aliases from the spec, in priority order within each field (earlier = preferred). */
const ALIASES: Record<Field, string[]> = {
  sku: ['item code', 'sku', 'material code', 'part number', 'part #', 'code'].map(normalizeHeader),
  description: ['description', 'item description', 'product name', 'item', 'material description'].map(normalizeHeader),
  quantity: ['qty', 'quantity', 'nos', 'required qty', 'volume', 'count'].map(normalizeHeader),
  uom: ['unit', 'uom', 'units', 'measure'].map(normalizeHeader),
};

/**
 * Regex rules for common spellings the exact aliases miss ("Req. Qty", "Material", "Short text", "Unit of Measure").
 * They rank below every exact alias. "short text" is listed before "long text" so the compact name wins.
 */
const PATTERNS: Record<Field, RegExp[]> = {
  sku: [/^(item|material|part|product|article|sap|catalog(ue)?)\s*(code|no|number|num|id)$/, /^material$/],
  description: [
    /^(short|item|material|product)\s*(text|name|desc|description)$/,
    /^(item |material |product )?description( of (goods|materials?|items?|products?))?$/, // "Description of Goods"
    /^long\s*text$/,
    /^(desc|particulars?)$/,
  ],
  quantity: [/^(total\s+|required\s+|req\s+|requested\s+|order(ed)?\s+)?(qty|quantity)(\s+(required|req))?$/, /^requirement$/],
  uom: [/^(unit of measure(ment)?|u\s*o\s*m|um)$/],
};

/** When two fields claim one header cell, the lower number wins. */
const FIELD_PRECEDENCE: Field[] = ['quantity', 'sku', 'uom', 'description'];

const HEADER_SCAN_ROWS = 5;
const MAX_COLUMNS = 60;
const PREVIEW_CELL_CHARS = 60;

export class ExcelParseError extends Error {
  constructor(
    readonly code: 'UNREADABLE' | 'EMPTY' | 'UNMAPPED_COLUMNS',
    message: string,
  ) {
    super(message);
    this.name = 'ExcelParseError';
  }
}

export interface ParseOptions {
  maxRows: number;
  /** Asked only when header rules fail. Its answer is validated against the real data before use. */
  resolveColumns?: ColumnResolver | undefined;
}

interface Classified {
  field: Field;
  rank: number;
}

/** What field (if any) does this header cell look like, and how confident is the match (lower = better)? */
function classifyHeader(text: string): Classified | null {
  const n = normalizeHeader(text);
  if (n === '') return null;
  let best: Classified | null = null;
  for (const field of FIELD_PRECEDENCE) {
    let rank = ALIASES[field].indexOf(n);
    if (rank < 0) {
      const p = PATTERNS[field].findIndex((re) => re.test(n));
      rank = p < 0 ? -1 : 100 + p;
    }
    if (rank >= 0 && (best === null || rank < best.rank)) best = { field, rank };
  }
  return best;
}

interface HeaderCandidate {
  headerRow: number; // 1-based
  mapping: ColumnMapping;
  score: number;
}

/** Look for the header in the first rows. Valid = a quantity column plus a code or description column. */
function detectHeader(previewRows: string[][]): HeaderCandidate | null {
  let best: HeaderCandidate | null = null;
  previewRows.forEach((cells, index) => {
    const chosen: Partial<Record<Field, { col: number; rank: number }>> = {};
    cells.forEach((text, col) => {
      const c = classifyHeader(text);
      if (!c) return;
      const current = chosen[c.field];
      if (!current || c.rank < current.rank) chosen[c.field] = { col, rank: c.rank };
    });
    const mapping: ColumnMapping = {
      headerRow: index + 1,
      sku: chosen.sku?.col ?? null,
      description: chosen.description?.col ?? null,
      quantity: chosen.quantity?.col ?? null,
      uom: chosen.uom?.col ?? null,
    };
    const valid = mapping.quantity !== null && (mapping.sku !== null || mapping.description !== null);
    if (!valid) return;
    const score = [mapping.sku, mapping.description, mapping.quantity, mapping.uom].filter((v) => v !== null).length;
    if (!best || score > best.score) best = { headerRow: index + 1, mapping, score };
  });
  return best;
}

function sheetWidth(ws: ExcelJS.Worksheet): number {
  return Math.min(Math.max(ws.columnCount, ws.actualColumnCount), MAX_COLUMNS);
}

function readRow(ws: ExcelJS.Worksheet, rowNumber: number, width: number): ExcelJS.CellValue[] {
  const row = ws.getRow(rowNumber);
  const cells: ExcelJS.CellValue[] = [];
  for (let c = 1; c <= width; c++) cells.push(row.getCell(c).value);
  return cells;
}

/** First rows as trimmed text, for header detection and for the LLM column resolver. */
export function previewRows(ws: ExcelJS.Worksheet, count = HEADER_SCAN_ROWS): string[][] {
  const width = sheetWidth(ws);
  const rows: string[][] = [];
  for (let r = 1; r <= count; r++) {
    const texts = readRow(ws, r, width).map((v) => cellToText(v).slice(0, PREVIEW_CELL_CHARS));
    while (texts.length > 0 && texts[texts.length - 1] === '') texts.pop();
    rows.push(texts);
  }
  return rows;
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw new ExcelParseError('UNREADABLE', `The file could not be opened as an .xlsx workbook (${(err as Error).message}).`);
  }
  return wb;
}

/** Prefer the visible sheet with a recognisable header (and most rows); else the first non-empty visible sheet. */
function pickSheet(wb: ExcelJS.Workbook): { ws: ExcelJS.Worksheet; header: HeaderCandidate | null } {
  const visible = wb.worksheets.filter((ws) => ws.state === 'visible' && ws.rowCount > 0);
  if (visible.length === 0) throw new ExcelParseError('EMPTY', 'The workbook has no sheets with data.');
  let best: { ws: ExcelJS.Worksheet; header: HeaderCandidate } | null = null;
  for (const ws of visible) {
    const header = detectHeader(previewRows(ws));
    if (header && (!best || ws.rowCount > best.ws.rowCount)) best = { ws, header };
  }
  return best ?? { ws: visible[0] as ExcelJS.Worksheet, header: null };
}

function rowPreview(cells: ExcelJS.CellValue[]): string {
  return cells
    .map((c) => cellToText(c).slice(0, 40))
    .filter((t) => t !== '')
    .join(' | ')
    .slice(0, 160);
}

interface Extraction {
  lines: RfqLine[];
  skipped: SkippedRow[];
  rowsScanned: number;
}

/** Row-by-row extraction. Pure data handling: no LLM, no arithmetic beyond number cleaning. */
function extractLines(ws: ExcelJS.Worksheet, mapping: ColumnMapping, maxRows: number): Extraction {
  const width = sheetWidth(ws);
  const first = (mapping.headerRow ?? 0) + 1;
  const last = Math.min(ws.rowCount, first + maxRows - 1);
  const lines: RfqLine[] = [];
  const skipped: SkippedRow[] = [];
  let rowsScanned = 0;

  const at = (cells: ExcelJS.CellValue[], col: number | null): ExcelJS.CellValue | undefined =>
    col === null ? undefined : cells[col];

  for (let r = first; r <= last; r++) {
    const cells = readRow(ws, r, width);
    if (cells.every((c) => cellToText(c) === '')) continue;
    rowsScanned++;

    const note = (category: SkippedRow['category'], reason: string) =>
      skipped.push({ rowNumber: r, category, reason, preview: rowPreview(cells) });

    // A repeated header row (multi-page exports) is not data: several header-like words and no numbers.
    const headerLike = cells.filter((c) => classifyHeader(cellToText(c)) !== null).length;
    if (headerLike >= 2 && !cells.some((c) => typeof cellToRaw(c) === 'number')) {
      note('dropped', 'repeated header row');
      continue;
    }

    const sku = cleanSku(at(cells, mapping.sku));
    const description = cellToText(at(cells, mapping.description));
    const quantityCell = at(cells, mapping.quantity);
    const quantityText = cellToText(quantityCell);

    if (!sku && isSummaryLabel(description)) {
      note('dropped', 'summary row');
      continue;
    }
    if (quantityText === '') {
      const filled = cells.filter((c) => cellToText(c) !== '').length;
      if (!sku) note('dropped', 'no quantity and no item code (heading or note)');
      // A lone sentence in the code column ("Prepared by Stores - SIVAIAH") is a footer, not an item.
      else if (filled === 1 && sku.split(' ').length >= 3) note('dropped', 'looks like a note, not an item');
      else note('unparseable', 'quantity is missing');
      continue;
    }

    const qty = parseQuantity(quantityCell);
    if (qty.value === null) {
      if (!sku && !description) note('dropped', 'no item and no readable quantity');
      else note('unparseable', `quantity "${quantityText.slice(0, 30)}" could not be read`);
      continue;
    }
    if (!sku && !description) {
      note('dropped', 'quantity without an item (likely a total)');
      continue;
    }
    if (qty.value < 0) {
      note('dropped', 'negative quantity');
      continue;
    }
    if (qty.value === 0) {
      note('dropped', 'zero quantity');
      continue;
    }

    const uomRaw = cellToText(at(cells, mapping.uom)) || qty.unitHint;
    lines.push({
      rowNumber: r,
      sku,
      description: description || (sku as string),
      quantity: qty.value,
      uomRaw: uomRaw || null,
      uom: normalizeUom(uomRaw),
    });
  }
  return { lines, skipped, rowsScanned };
}

/** An LLM-suggested mapping must point at real columns and actually yield quantities, or it is rejected. */
function validateResolvedMapping(m: ColumnMapping, width: number): string | null {
  const cols = [m.sku, m.description, m.quantity, m.uom];
  if (m.quantity === null) return 'no quantity column';
  if (m.sku === null && m.description === null) return 'no item column';
  if (cols.some((c) => c !== null && (!Number.isInteger(c) || c < 0 || c >= width))) return 'column index out of range';
  const used = cols.filter((c): c is number => c !== null);
  if (new Set(used).size !== used.length) return 'one column assigned to two fields';
  if (m.headerRow !== null && (!Number.isInteger(m.headerRow) || m.headerRow < 1 || m.headerRow > HEADER_SCAN_ROWS)) {
    return 'header row out of range';
  }
  return null;
}

function quantityHitRate(x: Extraction): number {
  const candidates = x.lines.length + x.skipped.filter((s) => s.category === 'unparseable').length;
  return candidates === 0 ? 0 : x.lines.length / candidates;
}

/**
 * Parse an RFQ workbook into clean lines.
 *  1. find the header among the first 5 rows using the alias list and regex rules;
 *  2. if that fails (no quantity column, or neither code nor description), ask `resolveColumns` for 0-based
 *     column indexes, then re-read the sheet with plain code and verify the answer produced real quantities.
 */
export async function parseRfq(buffer: Buffer, options: ParseOptions): Promise<ParseResult> {
  const wb = await loadWorkbook(buffer);
  const { ws, header } = pickSheet(wb);

  if (header) {
    const x = extractLines(ws, header.mapping, options.maxRows);
    return { sheetName: ws.name, mapping: header.mapping, mappingSource: 'rules', ...x };
  }

  logger.info('Header rules found no quantity/item columns', { sheet: ws.name });
  const resolved = options.resolveColumns ? await options.resolveColumns(previewRows(ws)) : null;
  if (!resolved) {
    throw new ExcelParseError(
      'UNMAPPED_COLUMNS',
      'Could not tell which columns hold the item code, description and quantity.',
    );
  }
  const problem = validateResolvedMapping(resolved, sheetWidth(ws));
  if (problem) {
    throw new ExcelParseError('UNMAPPED_COLUMNS', `The suggested column mapping was rejected (${problem}).`);
  }
  const x = extractLines(ws, resolved, options.maxRows);
  if (quantityHitRate(x) < 0.5) {
    throw new ExcelParseError(
      'UNMAPPED_COLUMNS',
      'The suggested column mapping did not produce readable quantities, so it was rejected.',
    );
  }
  return { sheetName: ws.name, mapping: resolved, mappingSource: 'llm', ...x };
}
