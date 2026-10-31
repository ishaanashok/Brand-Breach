import { describe, expect, test } from 'bun:test'
import { SEED_COMMENTARY, matchCommentary, normalizeCommentary } from '../src/core/commentary'
import { kase, initialCase, type CaseState } from '../src/core/machines/case'
import { initialPlaybook, playbook } from '../src/core/machines/playbook'
import { earnsReading } from '../src/core/policy'
import { DISCUSSES_WHY, hasReadableEvidence, summarize, usableText } from '../src/core/questions'
import { rulesCheck } from '../src/core/rules'
import type { Answer, Hit } from '../src/core/types'
import { readProblem } from '../src/harness/web'
import { MemoryStore } from '../src/store/memory'
import { verifyTick } from '../src/harness/verifier'

const yes = (name: string, p: number): Answer => ({ name, type: 'predicate', value: p >= 0.5, confidence: Math.max(p, 1 - p), probabilities: [{ value: true, p }, { value: false, p: 1 - p }] })
const hit = (o: Partial<Hit> = {}): Hit => ({ url: 'https://example.com/a', surface: 'domains', title: 'https://example.com/a', snippet: '', ...o })
const pageWords = 'Buy discount jackets from our outlet store today with free shipping on every order.'

describe('the shared list of scam commentary', () => {
  const rules = (url: string) => rulesCheck(hit({ url }), { officialDomains: ['ftc.example'], authorizedSellers: [], whitelist: [], commentary: SEED_COMMENTARY })

  test('clears a known site with a reason, at no cost', () => {
    expect(rules('https://www.scamadviser.com/check-website/x.com').clear).toContain('not a takedown target')
    expect(rules('https://reddit.com/r/Scams/comments/1abc').clear).toContain('reddit.com/r/scams')
  })

  test('never covers the rest of a shared platform', () => {
    expect(rules('https://reddit.com/r/Hoka/comments/1abc').clear).toBeNull()
    expect(rules('https://reddit.com/r/scamsters/comments/1abc').clear).toBeNull()
    expect(rules('https://notscamadviser.com/').clear).toBeNull()
    for (const shared of ['reddit.com', 'https://www.facebook.com/', 't.me', 'not a host']) expect(normalizeCommentary(shared)).toBeNull()
    for (const entry of SEED_COMMENTARY) expect(normalizeCommentary(entry)).toBe(entry)
  })

  test('lives on the playbook, and one saved before the list existed starts from the seed', () => {
    const old = { version: 3, priors: {}, hunts: [] }
    expect(playbook.getCommentary(old)[1]).toEqual(SEED_COMMENTARY)
    const [added, ok] = playbook.addCommentary(old, 'https://www.newchecker.example/')
    expect(ok).toBe(true)
    expect(added.commentary).toContain('newchecker.example')
    expect(playbook.addCommentary(initialPlaybook(), 'reddit.com')[1]).toBe(false)
    expect(playbook.removeCommentary(added, 'newchecker.example')[0].commentary).toEqual(SEED_COMMENTARY)
  })
})

describe('the labelled test set, without any model', () => {
  test('the list clears no real abuse', async () => {
    const rows: any[] = await Bun.file(new URL('fixtures/queue-labels.json', import.meta.url).pathname).json()
    const abuse = rows.filter(r => r.label === 'real_abuse')
    expect(abuse.length).toBeGreaterThanOrEqual(30)
    expect(rows.filter(r => r.label === 'scam_article').length).toBeGreaterThanOrEqual(30)
    expect(abuse.filter(r => matchCommentary(r.url, SEED_COMMENTARY)).map(r => r.url)).toEqual([])
  })
})

describe('scoring', () => {
  test('a page about scams scores low and says why, however alarming it reads', () => {
    const s = summarize([yes('impersonating', 0.9), yes('scam', 1), yes('discusses_scam', 0.98)])
    expect(s.discusses).toBe(true)
    expect(s.why).toBe(DISCUSSES_WHY)
    expect(s.score).toBeLessThan(0.1)
  })

  test('a coin flip is not called likely', () => {
    const s = summarize([yes('impersonating', 0.5), yes('scam', 0.5), yes('discusses_scam', 0.2)])
    expect(s.why).toContain('low signal')
  })

  test('a real fake keeps its score', () => {
    const s = summarize([yes('impersonating', 0.96), yes('scam', 0.4), yes('discusses_scam', 0.02)])
    expect(s).toMatchObject({ score: 0.96, discusses: false })
  })
})

describe('pages nobody could read', () => {
  test('a bot check or an empty page is not text', () => {
    expect(usableText('Prove your humanity We’re committed to safety and security. But not for bots. Complete the challenge below.')).toBe(false)
    expect(usableText('Loading…')).toBe(false)
    expect(usableText('')).toBe(false)
    expect(usableText(pageWords)).toBe(true)
  })

  test('a title that is only the address says nothing, and a real title or snippet does', () => {
    expect(hasReadableEvidence(hit({ title: 'https://www.reddit.com/r/PUMA/comments/1hyqdlv' }))).toBe(false)
    expect(hasReadableEvidence(hit({ title: 'Columbia Outlet 70% off' }))).toBe(true)
    expect(hasReadableEvidence(hit({ snippet: pageWords }))).toBe(true)
  })

  test('each failure has its own plain reason', () => {
    expect(readProblem(new Error('HTTP 403'))).toContain('blocks bots')
    expect(readProblem(new Error('getaddrinfo ENOTFOUND x.example'))).toContain('no working address')
    expect(readProblem(new Error('not a page: application/pdf'))).toContain('PDF')
  })

  test('a coin flip on an unread page still earns a free read when the bar has risen', () => {
    expect(earnsReading(0.5, 0.65, false)).toBe(true)
    expect(earnsReading(0.5, 0.65, true)).toBe(false)
    expect(earnsReading(0.2, 0.65, false)).toBe(false)
  })

  const setup = async (o: { h: Hit; capture: () => Promise<{ text?: string; problem?: string }>; answers: Answer[] }) => {
    const store = new MemoryStore()
    const input = { brand: 'Acme', keywords: ['acme'], officialDomains: [], authorizedSellers: [], budgetUsd: 1, precision: 'balanced' as const }
    await store.hunt('h').init('h', input, 1, 'test')
    await store.hunt('h').addCase('c')
    await store.kase('c').report('c', 'acme', 'h', o.h, 'domains', 1)
    await store.kase('c').setTriage({ answers: [], deciderId: 'd', usd: 0, latencyMs: 1, score: 0.5, confidence: 0.5, why: 'y' })
    let calls = 0
    const verify = { id: 'v', price: { usdPerMInput: 0 }, decide: async () => { calls++; return { answers: o.answers, deciderId: 'v', usage: { inputTokens: 0, usd: 0, latencyMs: 1 } } } } as any
    await verifyTick({ huntId: 'h', input, brandSlug: 'acme', store, me: { send: async () => {} } as any, verify, estUsd: 0, capture: o.capture })
    return { kase: await store.kase('c').snapshot(), hunt: await store.hunt('h').snapshot(), calls: () => calls }
  }

  test('an unreadable page is labelled, not scored or confirmed, and costs no decision', async () => {
    const { kase: c, hunt, calls } = await setup({ h: hit(), capture: async () => ({ problem: readProblem(new Error('HTTP 403')) }), answers: [] })
    expect(c.state).toBe('unreadable')
    expect(c.skipReason).toContain('blocks bots')
    expect(c.notice).toBeNull()
    expect(calls()).toBe(0)
    expect(hunt.counters).toMatchObject({ unreadable: 1, verified: 0 })
  })

  test('a bot check returned as page text is not stored as evidence', async () => {
    const { kase: c } = await setup({ h: hit(), capture: async () => ({ text: 'Verify to continue To continue, please confirm that you are a human and not a robot here.' }), answers: [] })
    expect(c.state).toBe('unreadable')
    expect(c.hit!.evidenceText).toBeUndefined()
  })

  test('the search snippet stands in for the page, and the reason says so', async () => {
    const { kase: c } = await setup({ h: hit({ snippet: pageWords }), capture: async () => ({ problem: 'blocked' }), answers: [yes('impersonating', 0.9), yes('scam', 0.1), yes('discusses_scam', 0.01)] })
    expect(c.state).toBe('awaiting_approval')
    expect(c.verification!.why).toContain('search result only')
  })

  test('a readable page about scams is cleared at the second check, with the reason', async () => {
    const { kase: c, hunt } = await setup({ h: hit(), capture: async () => ({ text: pageWords }), answers: [yes('impersonating', 0.9), yes('scam', 1), yes('discusses_scam', 0.99)] })
    expect(c.state).toBe('cleared')
    expect(c.skipReason).toBe(DISCUSSES_WHY)
    expect(hunt.counters.cleared).toBe(1)
  })

  test('a score of 0.50 on a readable page does not confirm it', async () => {
    const { kase: c } = await setup({ h: hit(), capture: async () => ({ text: pageWords }), answers: [yes('impersonating', 0.5), yes('scam', 0.5), yes('discusses_scam', 0.1)] })
    expect(c.state).toBe('cleared')
  })
})

describe('the case machine', () => {
  const at = (state: CaseState['state']): CaseState => ({ ...initialCase(), state })

  test('clear keeps its reason, and never touches what a person is deciding', () => {
    expect(kase.clear(at('new'), 'why')[0]).toMatchObject({ state: 'cleared', skipReason: 'why' })
    expect(kase.clear(at('triaged'), 'why')[0].state).toBe('cleared')
    for (const s of ['awaiting_approval', 'approved', 'rejected'] as const) expect(kase.clear(at(s), 'why')[0].state).toBe(s)
  })

  test('a second opinion can not undo a decision a person made', () => {
    const claimed = (state: CaseState['state']) => kase.claimReasoning(at(state), 'a', 'top', 1, 100)[0]
    const say = (s: CaseState) => kase.setReasoning(s, { verdict: 'legitimate', confidence: 0.9, reasoning: 'r' })[0].state
    expect(say(claimed('approved'))).toBe('approved')
    expect(say(claimed('rejected'))).toBe('rejected')
  })
})
