import crypto from 'node:crypto';
import { htmlToText } from 'html-to-text';
import { simpleParser } from 'mailparser';
import type { InboundMail, MailAttachment } from '../types';

const XLSX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);
/** Spreadsheet formats exceljs cannot read; the sender is asked to resend as .xlsx. */
const UNSUPPORTED_SHEET_EXT = new Set(['.xls', '.xlsb', '.ods', '.csv', '.numbers']);

function extension(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i).toLowerCase();
}

/**
 * SHA-256 over length-prefixed parts, so ("ab","c") and ("a","bc") never collide.
 */
export function sha256Hex(...parts: Array<Buffer | string>): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export interface EnquiryKeys {
  /** Idempotency key: this exact delivery of this exact file. sha256(excel bytes + sender + message-id). */
  messageKey: string;
  /** Fingerprint of the enquiry itself, ignoring which email carried it. sha256(excel bytes + sender). */
  contentHash: string;
}

export function computeKeys(content: Buffer, senderEmail: string, messageId: string): EnquiryKeys {
  const sender = senderEmail.trim().toLowerCase();
  return {
    contentHash: sha256Hex(content, sender),
    messageKey: sha256Hex(content, sender, messageId),
  };
}

// --- isolating the newest message ----------------------------------------------------------------

const REPLY_MARKERS: RegExp[] = [
  /^\s*-{2,}\s*(original message|forwarded message|reply message)\s*-{2,}\s*$/i,
  /^\s*begin forwarded message:?\s*$/i,
  /^\s*_{10,}\s*$/, // Outlook divider
  /^\s*on\s.{3,200}\bwrote:\s*$/i, // Gmail / Apple Mail
  /^\s*>/, // quoted line
];

/**
 * Keep only what the sender typed in THIS message: cut at the first reply/forward marker
 * ("On … wrote:", "-----Original Message-----", Outlook "From:/Sent:" block, quoted ">" lines).
 * The signature stays: it is where the company name usually is.
 */
export function isolateLatestMessage(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const next = lines[i + 1] ?? '';
    const wrapped = /^\s*on\s/i.test(line) && !/wrote:/i.test(line) && /^\s*on\s.{3,200}\bwrote:\s*$/i.test(`${line} ${next}`);
    const outlook =
      /^\s*(from|von|de):\s+\S/i.test(line) &&
      lines.slice(i + 1, i + 5).some((l) => /^\s*(sent|date|gesendet|envoy[ée]):\s/i.test(l));
    if (wrapped || outlook || REPLY_MARKERS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
  }
  const latest = lines.slice(0, cut).join('\n').trim();
  // A bare forward ("FYI" + forwarded enquiry) would otherwise leave nothing for the extractor to read.
  return latest.length >= 15 ? latest : text.replace(/\r\n?/g, '\n').trim();
}

// --- parsing -----------------------------------------------------------------------------------

/**
 * mailparser only derives plain text from HTML when the HTML is the whole message or sits beside a text part.
 * An HTML-only body that arrives together with an attachment (multipart/mixed) comes back with NO text, so the
 * enquiry would reach the extractor empty. Convert it here. Capped so a pathological message cannot stall a cycle.
 */
const MAX_HTML_CHARS = 300_000;

function textFromHtml(html: string): string {
  try {
    return htmlToText(html.slice(0, MAX_HTML_CHARS), {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
      ],
    }).trim();
  } catch {
    return '';
  }
}

export interface ParseMailOptions {
  maxAttachmentBytes: number;
}

export async function parseRawEmail(source: Buffer, options: ParseMailOptions): Promise<InboundMail> {
  const parsed = await simpleParser(source);

  const sender = parsed.from?.value[0];
  if (!sender?.address) throw new Error('Email has no sender address');

  const excelAttachments: MailAttachment[] = [];
  const unsupportedAttachments: string[] = [];
  for (const att of parsed.attachments) {
    const filename = att.filename?.trim() || 'attachment';
    const ext = extension(filename);
    const contentType = (att.contentType ?? '').toLowerCase();
    const isXlsx = ext === '.xlsx' || ext === '.xlsm' || XLSX_TYPES.has(contentType);
    if (isXlsx) {
      if (att.content.length > options.maxAttachmentBytes) {
        unsupportedAttachments.push(`${filename} (larger than ${Math.round(options.maxAttachmentBytes / 1048576)} MB)`);
      } else {
        excelAttachments.push({ filename, contentType, content: att.content });
      }
    } else if (UNSUPPORTED_SHEET_EXT.has(ext)) {
      unsupportedAttachments.push(filename);
    }
  }

  let bodyText = (parsed.text ?? '').trim();
  if (bodyText === '' && typeof parsed.html === 'string' && parsed.html.trim() !== '') bodyText = textFromHtml(parsed.html);
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];

  return {
    // Deterministic stand-in when a message has no Message-ID, so re-fetching it yields the same idempotency key.
    messageId: parsed.messageId?.trim() || `<no-message-id:${sha256Hex(source).slice(0, 32)}>`,
    from: { address: sender.address.toLowerCase(), name: (sender.name ?? '').trim() },
    subject: (parsed.subject ?? '').replace(/[\r\n]+/g, ' ').trim(),
    date: parsed.date ?? new Date(0),
    bodyText,
    // In-Reply-To / References mean the body carries quoted history, which is stripped here.
    latestText: isolateLatestMessage(bodyText),
    isReply: Boolean(parsed.inReplyTo) || references.length > 0,
    excelAttachments,
    unsupportedAttachments,
  };
}
