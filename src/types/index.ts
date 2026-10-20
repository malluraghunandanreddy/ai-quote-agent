/** Shared domain types. Kept dependency-free so every layer can import them. */

export type EnquiryStatus =
  | 'PROCESSING'
  | 'NEEDS_INFO'
  | 'HALTED_CUSTOMER_NOT_FOUND'
  | 'HALTED_CUSTOMER_AMBIGUOUS'
  | 'QUOTE_CREATED'
  | 'QUOTE_CREATED_WITH_EXCEPTIONS'
  | 'FAILED';

export type NotificationKind =
  | 'A_ADDITIONAL_INFO'
  | 'B_UNMATCHED_PRODUCTS'
  | 'C_DRAFT_CREATED'
  | 'CUSTOMER_NOT_FOUND'
  | 'PROCESSING_FAILED';

// --- Email -------------------------------------------------------------------------------------

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface InboundMail {
  messageId: string;
  from: { address: string; name: string };
  subject: string;
  date: Date;
  /** Full plain-text body as received (includes quoted history). */
  bodyText: string;
  /** Only the newest message: reply/forward history removed. */
  latestText: string;
  /** True when In-Reply-To / References are present (the body then carries quoted history). */
  isReply: boolean;
  excelAttachments: MailAttachment[];
  /** Spreadsheet-like attachments we cannot read (e.g. legacy .xls), by file name. */
  unsupportedAttachments: string[];
}

export interface EnquiryMeta {
  companyName: string | null;
  contactName: string | null;
  deliveryAddress: string | null;
  deliveryTimeline: string | null;
  specialNotes: string | null;
  /** Things a person should know about this email, e.g. "instructions_to_ai" (text aimed at an AI system). */
  flags: string[];
  source: 'llm' | 'heuristic';
}

// --- Excel -------------------------------------------------------------------------------------

/** Column positions are 0-based; headerRow is the 1-based sheet row holding the headers (null = none). */
export interface ColumnMapping {
  headerRow: number | null;
  sku: number | null;
  description: number | null;
  quantity: number | null;
  uom: number | null;
}

export interface RfqLine {
  /** 1-based row number in the sheet, for human-readable messages. */
  rowNumber: number;
  sku: string | null;
  description: string;
  quantity: number;
  uomRaw: string | null;
  /** Zoho Books standard unit, or null when the raw unit is unknown. */
  uom: string | null;
}

export interface SkippedRow {
  rowNumber: number;
  /** dropped = intentionally ignored (totals, negative quantity); unparseable = a person must look at it. */
  category: 'dropped' | 'unparseable';
  reason: string;
  preview: string;
}

export interface ParseResult {
  sheetName: string;
  mapping: ColumnMapping;
  mappingSource: 'rules' | 'llm';
  lines: RfqLine[];
  skipped: SkippedRow[];
  rowsScanned: number;
}

/** Asked to map columns when header rules fail. Returns null when it cannot (or LLM is disabled). */
export type ColumnResolver = (previewRows: string[][]) => Promise<ColumnMapping | null>;

// --- Zoho Books --------------------------------------------------------------------------------

export interface ZohoApi {
  get<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T = unknown>(
    path: string,
    body: unknown,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T>;
  /** Follows Zoho's page_context pagination and returns the concatenated `key` arrays. */
  getAllPages<T = unknown>(
    path: string,
    key: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]>;
}

export interface ZohoContact {
  contact_id: string;
  contact_name: string;
  company_name?: string;
  email?: string;
  status?: string;
  contact_type?: string;
  /** Registered Place of Supply (GST state code, e.g. "MH"). */
  place_of_contact?: string;
  gst_treatment?: string;
  gst_no?: string;
  currency_code?: string;
}

export interface ZohoItem {
  item_id: string;
  name: string;
  sku?: string;
  rate?: number;
  unit?: string;
  status?: string;
  product_type?: string;
}

export type CustomerMatchTier = 'email' | 'domain' | 'company_name';

export type CustomerResolution =
  | { status: 'found'; tier: CustomerMatchTier; confidence: 'exact' | 'probable'; contact: ZohoContact }
  | { status: 'ambiguous'; tier: CustomerMatchTier; candidates: ZohoContact[] }
  | { status: 'not_found' };

export type ItemMatch =
  | { status: 'matched'; by: 'sku' | 'name'; item: ZohoItem }
  | { status: 'unmatched'; reason: 'NOT_FOUND' | 'AMBIGUOUS' };

export interface MatchedLine {
  line: RfqLine;
  match: ItemMatch;
}

export interface EstimateLineItem {
  item_id?: string;
  name: string;
  description?: string;
  quantity: number;
  rate?: number;
  unit?: string;
}

export interface CreatedEstimate {
  estimateId: string;
  estimateNumber: string;
  status: string;
  total: number;
  currencyCode: string;
  /** Rows as stored by Zoho, in request order. */
  lineItems: Array<{ itemId: string | null; name: string; rate: number; quantity: number }>;
  /** True when this call found an estimate created by an earlier attempt instead of creating a new one. */
  reused: boolean;
}
