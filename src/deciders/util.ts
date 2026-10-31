import type { Question } from '../core/types'

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** Truncates to a token budget using the rough 4-characters-per-token estimate. */
export const truncateToTokens = (text: string, tokens: number) => text.slice(0, tokens * 4)

export function chunk(qs: Question[], size: number): Question[][] {
  const out: Question[][] = []
  for (let i = 0; i < qs.length; i += size) out.push(qs.slice(i, i + size))
  return out
}

export const withTimeout = (ms?: number) => (ms ? AbortSignal.timeout(ms) : undefined)
