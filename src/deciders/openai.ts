import type { Answer, DecideResult, Decider, Evidence, Question } from '../core/types'
import { chunk, truncateToTokens, withTimeout } from './util'

const PRICE_PER_M = 0.1
const MAX_QUESTIONS = 5
const MAX_INPUT_TOKENS = 100_000

type Opts = { apiKey: string; baseUrl?: string; fetch?: typeof fetch }

function toWire(q: Question) {
  if (q.type === 'predicate') return { type: 'predicate', name: q.name, instructions: q.text }
  if (q.type === 'choice') return { type: 'choice', name: q.name, instructions: q.text, choices: q.options.map(o => ({ value: o, description: o })) }
  return { type: 'score', name: q.name, instructions: q.text, levels: q.levels.map(l => ({ label: l, description: l })) }
}

function fromWire(a: any, q: Question): Answer {
  if (!a || a.type === 'refusal') return { name: q.name, type: q.type, value: false, probabilities: [], confidence: 0, refused: true }
  if (q.type === 'predicate') {
    const p = a.probability as number
    return {
      name: q.name, type: 'predicate', value: p >= 0.5,
      probabilities: [{ value: true, p }, { value: false, p: 1 - p }],
      confidence: Math.max(p, 1 - p),
    }
  }
  if (q.type === 'choice') {
    return {
      name: q.name, type: 'choice', value: a.choice, confidence: a.confidence,
      probabilities: a.probabilities.map((x: any) => ({ value: x.value, p: x.probability })),
    }
  }
  return {
    name: q.name, type: 'score', value: a.score, confidence: a.confidence,
    probabilities: a.probabilities.map((x: any) => ({ value: x.label, p: x.probability })),
  }
}

export function openaiDecider({ apiKey, baseUrl = 'https://api.openai.com', fetch: f = fetch }: Opts): Decider {
  const id = 'openai-decisions'
  return {
    id,
    caps: { images: true, maxQuestions: MAX_QUESTIONS, maxInputTokens: MAX_INPUT_TOKENS },
    price: { usdPerMInput: PRICE_PER_M },
    async decide(e: Evidence, qs: Question[], opts): Promise<DecideResult> {
      const t0 = performance.now()
      const content: object[] = [{ type: 'input_text', text: truncateToTokens(e.text, MAX_INPUT_TOKENS) }]
      for (const img of e.images ?? []) content.push({ type: 'input_image', image_url: img.dataUrl })
      const answers: Answer[] = []
      let inputTokens = 0
      // Reports differ on limits, so the adapter owns splitting.
      for (const part of chunk(qs, MAX_QUESTIONS)) {
        const res = await f(`${baseUrl}/v1/decisions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'gpt-6-luna', input: [{ role: 'user', content }], questions: part.map(toWire) }),
          signal: withTimeout(opts?.timeoutMs),
        })
        if (!res.ok) throw new Error(`decisions ${res.status}`)
        const body: any = await res.json()
        inputTokens += body.usage?.input_tokens ?? 0
        for (const q of part) answers.push(fromWire(body.answers?.find((a: any) => a.name === q.name), q))
      }
      return {
        answers, deciderId: id,
        usage: { inputTokens, usd: (inputTokens / 1e6) * PRICE_PER_M, latencyMs: performance.now() - t0 },
      }
    },
  }
}
