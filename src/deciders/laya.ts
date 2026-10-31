import type { Answer, DecideResult, Decider, Evidence, Question } from '../core/types'
import { chunk, estimateTokens, truncateToTokens, withTimeout } from './util'

const MAX_TOKENS = 512
const MAX_QUESTIONS = 5
// Visual evidence unavailable lowers confidence, which raises review priority.
const NO_VISUAL_PENALTY = 0.8

type Opts = { baseUrl?: string; fetch?: typeof fetch }

function toWire(q: Question) {
  if (q.type === 'predicate') return { type: 'noul', instructions: q.text }
  if (q.type === 'choice') return { type: 'choice', instructions: q.text, criteria: Object.fromEntries(q.options.map(o => [o, o])) }
  return { type: 'score', instructions: q.text, criteria: q.levels }
}

const toPairs = (p: unknown) =>
  p && typeof p === 'object' ? Object.entries(p as Record<string, number>).map(([value, n]) => ({ value, p: n })) : []

function fromWire(a: any, q: Question, penalty: number): Answer {
  if (!a) return { name: q.name, type: q.type, value: false, probabilities: [], confidence: 0, refused: true }
  if (q.type === 'predicate') {
    const p = a.noul as number
    return {
      name: q.name, type: 'predicate', value: p >= 0.5,
      probabilities: [{ value: true, p }, { value: false, p: 1 - p }],
      confidence: Math.max(p, 1 - p) * penalty,
    }
  }
  const value = q.type === 'choice' ? a.choice : a.score
  return { name: q.name, type: q.type, value, probabilities: toPairs(a.probabilities), confidence: (a.confidence ?? 0) * penalty }
}

/** Talks to the local sidecar described in sidecar/README.md. */
export function layaDecider({ baseUrl = 'http://127.0.0.1:8765', fetch: f = fetch }: Opts = {}): Decider {
  const id = 'laya-local'
  return {
    id,
    caps: { images: false, maxQuestions: MAX_QUESTIONS, maxInputTokens: MAX_TOKENS },
    price: { usdPerMInput: 0 },
    async decide(e: Evidence, qs: Question[], opts): Promise<DecideResult> {
      const t0 = performance.now()
      const dropped = (e.images?.length ?? 0) > 0
      const notes = (e.images ?? []).map(i => i.description).filter(Boolean).join(' ')
      const state = truncateToTokens(notes ? `Image notes: ${notes}\n${e.text}` : e.text, MAX_TOKENS)
      const penalty = dropped ? NO_VISUAL_PENALTY : 1
      const answers: Answer[] = []
      for (const part of chunk(qs, MAX_QUESTIONS)) {
        const res = await f(`${baseUrl}/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, questions: Object.fromEntries(part.map(q => [q.name, toWire(q)])) }),
          signal: withTimeout(opts?.timeoutMs),
        })
        if (!res.ok) throw new Error(`laya ${res.status}`)
        const body: any = await res.json()
        for (const q of part) answers.push(fromWire(body.answers?.[q.name], q, penalty))
      }
      return {
        answers, deciderId: id, visualEvidenceUnavailable: dropped,
        usage: { inputTokens: estimateTokens(state), usd: 0, latencyMs: performance.now() - t0 },
      }
    },
  }
}
