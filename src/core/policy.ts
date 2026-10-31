import type { Precision } from './types'

export type ShortlistCandidate = { id: string; p: number; severity: number; estCostUsd: number }

const SHIFT: Record<Precision, number> = { precision: 0.15, balanced: 0, recall: -0.15 }

export const thresholdFor = (base: number, precision: Precision) =>
  Math.min(0.95, Math.max(0.05, base + SHIFT[precision]))

/** A score of about 0.5 on a page nobody has read is "don't know", so reading it still costs nothing even if the bar has risen. */
export const earnsReading = (score: number, threshold: number, readable: boolean) =>
  score >= threshold || (!readable && Math.abs(score - 0.5) <= 0.05)

/** Probability times value divided by estimated cost, within the remaining budget. */
export function rankShortlist<T extends ShortlistCandidate>(cs: T[], { threshold, remainingUsd }: { threshold: number; remainingUsd: number }): T[] {
  const value = (c: T) => (c.p * c.severity) / Math.max(c.estCostUsd, 1e-6)
  const out: T[] = []
  let left = remainingUsd
  for (const c of cs.filter(c => c.p >= threshold).sort((a, b) => value(b) - value(a))) {
    if (c.estCostUsd > left) continue
    out.push(c)
    left -= c.estCostUsd
  }
  return out
}
