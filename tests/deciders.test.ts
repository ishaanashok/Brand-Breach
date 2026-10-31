import { expect, test } from 'bun:test'
import { openaiDecider } from '../src/deciders/openai'
import { layaDecider } from '../src/deciders/laya'
import { fallbackChain } from '../src/deciders/fallback'
import { shadowDecider, type ShadowLog } from '../src/deciders/shadow'
import { mockDecider } from '../src/deciders/mock'
import { checkContract } from '../src/deciders/contract'
import { deciderFromConfig } from '../src/deciders/config'
import type { Decider, Question } from '../src/core/types'

const qs: Question[] = [
  { type: 'predicate', name: 'imp', text: 'Impersonating?' },
  { type: 'choice', name: 'surface', text: 'Surface?', options: ['website', 'other'] },
  { type: 'score', name: 'sev', text: 'Severity?', levels: ['low', 'mid', 'high'] },
]
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })

test('OpenAI adapter sends documented fields and normalises answers', async () => {
  let body: any, url = ''
  const f = (async (u: string, init: any) => {
    url = u; body = JSON.parse(init.body)
    return json({
      answers: [
        { type: 'predicate', name: 'imp', probability: 0.9 },
        { type: 'choice', name: 'surface', choice: 'website', confidence: 0.7, probabilities: [{ value: 'website', probability: 0.7 }, { value: 'other', probability: 0.3 }] },
        { type: 'score', name: 'sev', score: 1.6, confidence: 0.6, probabilities: [{ value: 0, label: 'low', probability: 0.1 }, { value: 1, label: 'mid', probability: 0.2 }, { value: 2, label: 'high', probability: 0.7 }] },
      ],
      usage: { input_tokens: 1000 },
    })
  }) as any
  const d = openaiDecider({ apiKey: 'k', fetch: f })
  const r = await d.decide({ text: 'hello', images: [{ dataUrl: 'data:image/png;base64,AA' }] }, qs)
  expect(url).toEndWith('/v1/decisions')
  expect(body.model).toBe('gpt-6-luna')
  expect(body.questions[0]).toEqual({ type: 'predicate', name: 'imp', instructions: 'Impersonating?' })
  expect(body.questions[1].choices[0]).toEqual({ value: 'website', description: 'website' })
  expect(body.questions[2].levels[2]).toEqual({ label: 'high', description: 'high' })
  expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AA' })
  expect(r.answers[0]).toMatchObject({ value: true, confidence: 0.9 })
  expect(r.answers[0]!.probabilities.find(p => p.value === true)!.p).toBeCloseTo(0.9)
  expect(r.answers[2]!.value).toBeCloseTo(1.6)
  expect(r.usage.usd).toBeCloseTo(0.0001)
  expect(r.deciderId).toBe('openai-decisions')
})

test('OpenAI refusal normalises to a zero-confidence answer', async () => {
  const f = (async () => json({ answers: [{ type: 'refusal', name: 'imp' }], usage: { input_tokens: 1 } })) as any
  const r = await openaiDecider({ apiKey: 'k', fetch: f }).decide({ text: 'x' }, [qs[0]!])
  expect(r.answers[0]).toMatchObject({ confidence: 0, refused: true })
})

test('adapter splits question sets over its limit', async () => {
  let calls = 0
  const f = (async (_: string, init: any) => {
    calls++
    const b = JSON.parse(init.body)
    return json({ answers: b.questions.map((q: any) => ({ type: 'predicate', name: q.name, probability: 0.5 })), usage: { input_tokens: 10 } })
  }) as any
  const many = Array.from({ length: 7 }, (_, i) => ({ type: 'predicate' as const, name: `q${i}`, text: 't' }))
  const r = await openaiDecider({ apiKey: 'k', fetch: f }).decide({ text: 'x' }, many)
  expect(calls).toBe(2)
  expect(r.answers).toHaveLength(7)
  expect(r.usage.inputTokens).toBe(20)
})

test('Laya maps predicate to noul, truncates text, drops images, costs nothing', async () => {
  let body: any
  const f = (async (_: string, init: any) => {
    body = JSON.parse(init.body)
    return json({ answers: {
      imp: { type: 'noul', noul: 0.8, confidence: 0.8 },
      surface: { type: 'choice', choice: 'other', confidence: 0.6, probabilities: { website: 0.4, other: 0.6 } },
      sev: { type: 'score', score: 2, confidence: 0.5, probabilities: { low: 0.2, mid: 0.3, high: 0.5 } },
    } })
  }) as any
  const d = layaDecider({ fetch: f })
  const r = await d.decide({ text: 'word '.repeat(5000), images: [{ dataUrl: 'x', description: 'a logo' }] }, qs)
  expect(body.questions.imp.type).toBe('noul')
  expect(body.questions.surface.criteria).toEqual({ website: 'website', other: 'other' })
  expect(body.questions.sev.criteria).toEqual(['low', 'mid', 'high'])
  expect(body.state.length).toBeLessThanOrEqual(512 * 4)
  expect(body.state).toContain('a logo')
  expect(r.usage.usd).toBe(0)
  expect(r.visualEvidenceUnavailable).toBe(true)
  expect(r.answers[0]).toMatchObject({ value: true })
  expect(r.answers[0]!.confidence).toBeLessThan(0.8)
  expect(r.deciderId).toBe('laya-local')
})

const failing = (id: string, err = 'boom'): Decider => ({
  id, caps: { images: false, maxQuestions: 5, maxInputTokens: 512 }, price: { usdPerMInput: 0 },
  decide: async () => { throw new Error(err) },
})
const never = (id: string): Decider => ({ ...failing(id), decide: () => new Promise(() => {}) })

test('fallback falls through on error and timeout and reports who answered', async () => {
  const fell: string[] = []
  const c = fallbackChain([failing('a'), never('b'), mockDecider()], { timeoutMs: 20, onFallback: (from) => fell.push(from) })
  const r = await c.decide({ text: 'free tesla crypto giveaway' }, [qs[0]!])
  expect(r.deciderId).toBe('mock-heuristic')
  expect(fell).toEqual(['a', 'b'])
})

test('fallback rejects when every decider fails', async () => {
  await expect(fallbackChain([failing('a')], { timeoutMs: 20 }).decide({ text: 'x' }, [qs[0]!])).rejects.toThrow('all deciders failed')
})

test('shadow logs disagreement without changing the result or failing on shadow error', async () => {
  const logs: ShadowLog[] = []
  const fixed = (id: string, p: number): Decider => ({
    ...failing(id),
    decide: async () => ({ deciderId: id, usage: { inputTokens: 0, usd: 0, latencyMs: 1 }, answers: [{ name: 'imp', type: 'predicate', value: p > 0.5, confidence: 1, probabilities: [] }] }),
  })
  const d = shadowDecider(fixed('main', 0.9), fixed('other', 0.1), l => logs.push(l))
  const r = await d.decide({ text: 'x' }, [qs[0]!])
  await new Promise(res => setTimeout(res, 5))
  expect(r.deciderId).toBe('main')
  expect(logs[0]).toMatchObject({ primary: 'main', shadow: 'other', agreed: false })
  const ok = await shadowDecider(fixed('main', 0.9), failing('bad'), () => {}).decide({ text: 'x' }, [qs[0]!])
  expect(ok.deciderId).toBe('main')
})

test('contract check passes the mock and rejects bad probabilities', async () => {
  const items = [{ text: 'free tesla giveaway', truth: true }, { text: 'tesla owner manual review', truth: false }]
  const good = await checkContract(mockDecider(), items, { maxP95Ms: 1000 })
  expect(good.ok).toBe(true)
  const bad: Decider = { ...failing('bad'), decide: async () => ({ deciderId: 'bad', usage: { inputTokens: 0, usd: 0, latencyMs: 1 }, answers: [
    { name: 'impersonating', type: 'predicate', value: true, confidence: 1, probabilities: [{ value: true, p: 0.9 }, { value: false, p: 0.9 }] },
  ] }) }
  const r = await checkContract(bad, items, { maxP95Ms: 1000 })
  expect(r.ok).toBe(false)
  expect(r.problems.join()).toContain('sum')
})

test('config picks modes and never needs code changes', () => {
  expect(deciderFromConfig({ DECIDER_MODE: 'mock' }, {}).triage.id).toBe('fallback(mock-heuristic)')
  const laya = deciderFromConfig({ DECIDER_MODE: 'laya' }, {})
  expect(laya.triage.id).toBe('fallback(laya-local>mock-heuristic)')
  const hybrid = deciderFromConfig({ DECIDER_MODE: 'hybrid', OPENAI_API_KEY: 'k' }, {})
  expect(hybrid.triage.id).toContain('laya-local')
  expect(hybrid.verify.id).toContain('openai-decisions')
  expect(deciderFromConfig({ DECIDER_MODE: 'shadow', OPENAI_API_KEY: 'k' }, {}).triage.id).toContain('shadow')
  expect(() => deciderFromConfig({ DECIDER_MODE: 'target' }, {})).toThrow('OPENAI_API_KEY')
})
