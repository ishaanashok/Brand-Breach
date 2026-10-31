import type { Answer, DecideResult, Decider, Evidence, Question } from '../core/types'
import { estimateTokens } from './util'

const SCAM = /(giveaway|double your|send .*(btc|eth|crypto)|wallet|airdrop|free tesla|\b90% off\b|replica|counterfeit|deepfake|official promo|limited claim|fake|knock.?off)/gi
const BENIGN = /(review|owner'?s? manual|news|recall notice|fan club|forum discussion|repair guide|official store)/gi

const count = (t: string, r: RegExp) => (t.match(r) ?? []).length

/**
 * Keyword stand-in used when neither Laya nor OpenAI is reachable.
 * The dashboard shows its id, so its answers are never mistaken for a real model's.
 */
export function mockDecider(): Decider {
  const id = 'mock-heuristic'
  return {
    id,
    caps: { images: false, maxQuestions: 5, maxInputTokens: 512 },
    price: { usdPerMInput: 0 },
    async decide(e: Evidence, qs: Question[]): Promise<DecideResult> {
      const t0 = performance.now()
      const signal = count(e.text, SCAM) - count(e.text, BENIGN)
      const p = Math.min(0.97, Math.max(0.03, 0.35 + signal * 0.22))
      const answers = qs.map((q): Answer => {
        if (q.type === 'predicate') {
          return { name: q.name, type: q.type, value: p >= 0.5, confidence: Math.max(p, 1 - p), probabilities: [{ value: true, p }, { value: false, p: 1 - p }] }
        }
        if (q.type === 'choice') {
          const each = 1 / q.options.length
          const hit = q.options.find(o => e.text.toLowerCase().includes(o)) ?? q.options.at(-1)!
          return { name: q.name, type: q.type, value: hit, confidence: each, probabilities: q.options.map(o => ({ value: o, p: each })) }
        }
        const top = q.levels.length - 1
        const each = 1 / q.levels.length
        return { name: q.name, type: q.type, value: p * top, confidence: each, probabilities: q.levels.map(l => ({ value: l, p: each })) }
      })
      return { answers, deciderId: id, usage: { inputTokens: estimateTokens(e.text), usd: 0, latencyMs: performance.now() - t0 } }
    },
  }
}
