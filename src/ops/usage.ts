import type { Config } from '../config';
import type { Repository } from '../db/repository';
import { localParts, startOfLocalDay } from '../dashboard/format';
import { usageCost } from './monitor';

/** What this calendar month (in the client's time zone) has used. Informational: nothing is limited or billed per use. */
export interface MonthUsage {
  monthLabel: string;
  drafts: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export function monthUsage(repo: Repository, config: Config, now: Date): MonthUsage {
  const tz = config.timezone;
  const monthKey = localParts(now, tz).ymd.slice(0, 7);
  const start = startOfLocalDay(new Date(`${monthKey}-01T12:00:00Z`), tz);
  const ai = usageCost(repo.llmUsageSince(`${monthKey}-01`), config.llm);
  return {
    monthLabel: new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${monthKey}-15T12:00:00Z`)),
    drafts: repo.draftsSince(start.toISOString()),
    aiCalls: ai.calls,
    tokensIn: ai.inputTokens,
    tokensOut: ai.outputTokens,
    costUsd: ai.estimatedUsd,
  };
}
