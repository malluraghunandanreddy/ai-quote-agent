import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { Config } from '../config';
import { logger } from '../logger';

export type LlmErrorKind = 'disabled' | 'refusal' | 'truncated' | 'invalid' | 'api';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface StructuredRequest<S extends z.ZodType> {
  /** Label for the usage report (e.g. "email_extraction"). */
  task?: string;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
}

export interface TextRequest {
  task?: string;
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock milliseconds spent waiting for the model. */
  ms: number;
}

export interface LlmStats {
  total: LlmUsage & { estimatedUsd: number };
  byTask: Record<string, LlmUsage>;
}

/** Models sometimes wrap JSON in a ```json fence even when asked not to. */
function parseJson(text: string): unknown {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(bare);
  } catch {
    throw new LlmError('invalid', 'The model did not return valid JSON.');
  }
}

/**
 * Thin wrapper over Anthropic Claude (Haiku 5.5 by default) used for the three language tasks only: reading
 * ambiguous emails, mapping odd spreadsheet headers, and wording exception notices. Everything it returns is
 * validated by callers; it is never the source of a quantity, price, code or tax amount.
 *
 * Request shape for Haiku 5.5: adaptive thinking (the default, so `thinking` is omitted), `effort` set low for these
 * short extraction jobs, structured outputs via `output_config.format`, and none of the parameters it rejects
 * (temperature / top_p / top_k, thinking budgets, assistant prefill, forced tool use).
 */
export class LlmClient {
  private readonly sdk: Anthropic | null;
  private readonly usage = new Map<string, LlmUsage>();
  private readonly callTimes: number[] = [];
  private capWarnedAt = 0;

  /** `fetch` is only overridden by tests, to inspect the exact HTTP request without network access. */
  constructor(
    private readonly cfg: Config['llm'],
    options: { fetch?: typeof fetch } = {},
  ) {
    this.sdk =
      cfg.enabled && cfg.apiKey
        ? new Anthropic({
            apiKey: cfg.apiKey,
            timeout: cfg.timeoutMs,
            // SDK-level retry with backoff for connection errors, 408, 409, 429 and 5xx (incl. 529 overloaded).
            maxRetries: cfg.maxRetries,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          })
        : null;
  }

  isEnabled(): boolean {
    return this.sdk !== null;
  }

  /** Calls, tokens, waiting time and an estimated cost since construction (or the last `resetStats`). */
  stats(): LlmStats {
    const total: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
    const byTask: Record<string, LlmUsage> = {};
    for (const [task, u] of this.usage) {
      byTask[task] = { ...u };
      total.calls += u.calls;
      total.inputTokens += u.inputTokens;
      total.outputTokens += u.outputTokens;
      total.ms += u.ms;
    }
    const estimatedUsd = (total.inputTokens * this.cfg.priceInPerMTok + total.outputTokens * this.cfg.priceOutPerMTok) / 1_000_000;
    return { total: { ...total, estimatedUsd }, byTask };
  }

  resetStats(): void {
    this.usage.clear();
  }

  private record(task: string | undefined, usage: { input_tokens: number; output_tokens: number }, startedAt: number): void {
    const key = task ?? 'other';
    const u = this.usage.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
    u.calls += 1;
    u.inputTokens += usage.input_tokens;
    u.outputTokens += usage.output_tokens;
    u.ms += Date.now() - startedAt;
    this.usage.set(key, u);
  }

  /**
   * JSON constrained by a Zod schema (structured outputs) and validated on return. The stop reason is checked BEFORE
   * parsing, so a refusal or a cut-off answer is reported as such instead of as "invalid JSON".
   */
  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    const sdk = this.requireSdk();
    this.enforceCap();
    let text: string;
    const startedAt = Date.now();
    try {
      const response = await sdk.messages.create({
        model: this.cfg.model,
        max_tokens: req.maxTokens ?? 8_192,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: zodOutputFormat(req.schema), effort: this.cfg.effort },
      });
      this.record(req.task, response.usage, startedAt);
      this.assertUsable(response.stop_reason, response.stop_details?.category ?? null);
      logger.debug('Claude structured call', { task: req.task, model: response.model, usage: response.usage });
      text = this.textOf(response.content);
    } catch (err) {
      throw this.wrap(err);
    }

    const parsed = req.schema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new LlmError('invalid', `The model's JSON did not match the expected shape: ${parsed.error.message.slice(0, 300)}`);
    }
    return parsed.data;
  }

  /** Plain text (used only for human-readable notices). */
  async text(req: TextRequest): Promise<string> {
    const sdk = this.requireSdk();
    this.enforceCap();
    const startedAt = Date.now();
    try {
      const response = await sdk.messages.create({
        model: this.cfg.model,
        max_tokens: req.maxTokens ?? 4_096,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: this.cfg.effort },
      });
      this.record(req.task, response.usage, startedAt);
      this.assertUsable(response.stop_reason, response.stop_details?.category ?? null);
      logger.debug('Claude text call', { task: req.task, model: response.model, usage: response.usage });
      return this.textOf(response.content).trim();
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private textOf(content: Anthropic.ContentBlock[]): string {
    return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  }

  /** Sliding one-hour window. Over the cap, callers get an LlmError and fall back to the rules-only path. */
  private enforceCap(): void {
    const now = Date.now();
    while (this.callTimes.length > 0 && (this.callTimes[0] as number) < now - 3_600_000) this.callTimes.shift();
    if (this.callTimes.length >= this.cfg.maxCallsPerHour) {
      if (now - this.capWarnedAt > 600_000) {
        this.capWarnedAt = now;
        logger.warn('Hourly model-call cap reached; using the rules-only path until it clears', { cap: this.cfg.maxCallsPerHour });
      }
      throw new LlmError('api', `Hourly model-call cap reached (${this.cfg.maxCallsPerHour}).`);
    }
    this.callTimes.push(now);
  }

  private requireSdk(): Anthropic {
    if (!this.sdk) throw new LlmError('disabled', `The language model is not enabled (${this.cfg.disabledReason ?? 'no ANTHROPIC_API_KEY'}).`);
    return this.sdk;
  }

  private assertUsable(stopReason: string | null, category: string | null): void {
    if (stopReason === 'refusal') {
      throw new LlmError('refusal', `The model declined the request${category ? ` (${category})` : ''}.`);
    }
    if (stopReason === 'max_tokens') throw new LlmError('truncated', 'The model response was cut off.');
  }

  private wrap(err: unknown): LlmError {
    if (err instanceof LlmError) return err;
    if (err instanceof Anthropic.APIError) {
      return new LlmError('api', `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`, err.status);
    }
    return new LlmError('invalid', err instanceof Error ? err.message : String(err));
  }
}
