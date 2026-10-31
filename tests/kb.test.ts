import { describe, expect, test } from 'bun:test'
import { pickEscalations } from '../src/core/escalate'
import { buildGraph } from '../src/core/graph'
import { entityFrom, fromProposals, kbEntities, matchKb, normalizeKb, resembles } from '../src/core/kb'
import { chooseSteer } from '../src/core/lanes'
import { brand, initialBrand } from '../src/core/machines/brand'
import { initialCase, kase, type CaseState } from '../src/core/machines/case'
import { rulesCheck } from '../src/core/rules'

const dom = entityFrom('domain', 'tesla.com', 'operator', 1, '')!
const acct = entityFrom('account', 'https://www.chirp.example/Tesla/', 'reasoner', 0.95, 'x')!

describe('knowledge base trust', () => {
  test('never trusts a whole platform, or an account without a path', () => {
    expect(normalizeKb('domain', 'youtube.com')).toBeNull()
    expect(normalizeKb('domain', 'https://www.Amazon.com/')).toBeNull()
    expect(normalizeKb('account', 'chirp.example')).toBeNull()
    expect(normalizeKb('account', 'youtube.com/@tesla')).toBe('youtube.com/@tesla')
  })

  test('a model only verifies above the bar; below it stays a candidate', () => {
    const [hi, lo, bad] = fromProposals([
      { kind: 'domain', value: 'tesla.com', confidence: 0.9 },
      { kind: 'domain', value: 'tesla-shop.com', confidence: 0.6 },
      { kind: 'domain', value: 'x.com', confidence: 1 },
    ])
    expect(hi!.status).toBe('verified')
    expect(lo!.status).toBe('candidate')
    expect(bad).toBeUndefined()
  })

  test('matching respects domain and path boundaries', () => {
    const k = [dom, acct]
    expect(matchKb({ url: 'https://shop.tesla.com/x' }, k)?.id).toBe(dom.id)
    expect(matchKb({ url: 'https://tesla.com.evil.example/' }, k)).toBeNull()
    expect(matchKb({ url: 'https://nottesla.com/' }, k)).toBeNull()
    expect(matchKb({ url: 'https://chirp.example/tesla/status/1' }, k)?.id).toBe(acct.id)
    expect(matchKb({ url: 'https://chirp.example/tesla_airdrop/status/1' }, k)).toBeNull()
  })

  test('a candidate never clears a hit', () => {
    const cand = entityFrom('domain', 'maybe.example', 'reasoner', 0.5, '')!
    expect(rulesCheck({ url: 'https://maybe.example/', surface: 'domains', title: '', snippet: '' }, { officialDomains: [], authorizedSellers: [], whitelist: [], kb: [cand] }).skip).toBeNull()
  })

  test('flags lookalikes without treating the real one as one', () => {
    expect(resembles('https://tesla-x2-promo.example', [dom])?.id).toBe(dom.id)
    expect(resembles('https://tes1a.example', [dom])?.id).toBe(dom.id)
    expect(resembles('https://tesla.com', [dom])).toBeNull()
    expect(resembles('https://evreviews.example', [dom])).toBeNull()
  })

  test('an entry a person removed stays out of later builds', () => {
    let [s] = brand.setKb(initialBrand(), [acct], 'luna', 1)
    ;[s] = brand.removeKbEntity(s, acct.id)
    ;[s] = brand.setKb(s, [acct], 'luna', 2)
    expect(kbEntities(s).some(e => e.id === acct.id)).toBe(false)
  })

  test('operator entries merge in and outrank the model', () => {
    const [s] = brand.setKb({ ...initialBrand(), officialDomains: ['tesla.com'] }, [entityFrom('domain', 'tesla.com', 'reasoner', 0.81, 'm')!], 'luna', 1)
    expect(kbEntities(s).find(e => e.value === 'tesla.com')!.source).toBe('operator')
  })
})

const hit = { url: 'https://a.example', surface: 'domains' as const, title: 't', snippet: 's' }
const mk = (id: string, patch: Partial<CaseState>): CaseState => ({ ...initialCase(), id, hit, ...patch })
const rec = (score: number, confidence = 0.9) => ({ answers: [], deciderId: 'd', usd: 0, latencyMs: 0, score, confidence, why: '' })
const opts = { slots: 9, now: 1000, threshold: () => 0.7 }

describe('escalation', () => {
  test('failed decisions first, then unsure, then the top of the human queue', () => {
    const out = pickEscalations([
      mk('top', { state: 'awaiting_approval', verification: { ...rec(0.95), verified: true } }),
      mk('unsure', { state: 'cleared', verification: { ...rec(0.45), verified: false } }),
      mk('failed', { state: 'undecided' }),
      mk('clear', { state: 'cleared', verification: { ...rec(0.05), verified: false } }),
    ], opts)
    expect(out.map(e => [e.caseId, e.trigger])).toEqual([['failed', 'undecided'], ['unsure', 'unsure'], ['top', 'top']])
  })

  test('leaves triaged cases the verifier will pick up, and respects slots', () => {
    expect(pickEscalations([mk('v', { state: 'triaged', triage: rec(0.6) })], { ...opts, threshold: () => 0.5 })).toEqual([])
    expect(pickEscalations([mk('r', { state: 'triaged', triage: rec(0.6) })], opts)).toEqual([{ caseId: 'r', trigger: 'unsure' }])
    expect(pickEscalations([mk('a', { state: 'undecided' }), mk('b', { state: 'undecided' })], { ...opts, slots: 1 })).toHaveLength(1)
  })

  test('caps top candidates per hunt, skips claimed, retakes a dead claim', () => {
    const top = (id: string) => mk(id, { state: 'awaiting_approval', verification: { ...rec(0.9), verified: true } })
    const used = { status: 'done' as const, agent: 'x', trigger: 'top' as const, at: 0 }
    expect(pickEscalations([{ ...top('a'), reasoning: used }, { ...top('b'), reasoning: used }, top('c')], opts)).toEqual([])
    const running = { status: 'running' as const, agent: 'x', trigger: 'undecided' as const, at: 0 }
    expect(pickEscalations([mk('a', { state: 'undecided', reasoning: running })], opts)).toEqual([])
    expect(pickEscalations([mk('a', { state: 'undecided', reasoning: running })], { ...opts, now: 200_000 })).toHaveLength(1)
  })
})

describe('reasoner authority', () => {
  const claimed = (patch: Partial<CaseState>) => kase.claimReasoning(mk('c', patch), 'r1', 'top', 1, 100)[0]
  const say = (s: CaseState, verdict: 'infringing' | 'legitimate' | 'unsure', confidence = 0.9) => kase.setReasoning(s, { verdict, confidence, reasoning: 'r' })

  test('cannot remove a case from the human queue; records the disagreement', () => {
    const [s] = say(claimed({ state: 'awaiting_approval' }), 'legitimate')
    expect(s.state).toBe('awaiting_approval')
    expect(s.reasoning!.disagrees).toBe(true)
  })

  test('a confident verdict settles an undecided case either way', () => {
    expect(say(claimed({ state: 'undecided' }), 'infringing')[1]).toEqual({ state: 'verified', newlyVerified: true })
    expect(say(claimed({ state: 'undecided' }), 'legitimate')[0].state).toBe('cleared')
  })

  test('unsure or low confidence changes nothing', () => {
    expect(say(claimed({ state: 'undecided' }), 'unsure')[0].state).toBe('undecided')
    expect(say(claimed({ state: 'undecided' }), 'infringing', 0.5)[0].state).toBe('undecided')
  })

  test('only one reasoner can claim a case', () => {
    expect(kase.claimReasoning(claimed({ state: 'undecided' }), 'r2', 'top', 2, 100)[1]).toBe(false)
  })
})

describe('steering', () => {
  const lane = (source: any, strategy: string) => ({ source, strategy, query: 'q' })
  const [a, b] = [lane('social', 'a'), lane('social', 'b')]
  const base = { current: a, candidates: [a, b], lastSteerAt: 0, now: 1e6, taken: [], stats: {} }

  test('leaves a lane that is not working', () => {
    const s = chooseSteer({ ...base, stats: { 'social/a': { tries: 3, hits: 0, costUsd: 0.01 } } })
    expect(s?.kind).toBe('stalled')
    expect(s?.lane).toEqual(b)
    expect(s?.reason).toContain('not working')
  })

  test('says when the site itself is failing', () => {
    expect(chooseSteer({ ...base, exhausted: ['social/a'], blocked: ['social/a'] })?.kind).toBe('blocked')
  })

  test('changes direction to another surface when this one is spent', () => {
    const far = lane('video', 'x')
    const s = chooseSteer({ ...base, exhausted: ['social/a', 'social/b'], elsewhere: [far] })
    expect(s).toMatchObject({ kind: 'cross-surface', lane: far })
  })

  test('does not double up on a lane another scout has', () => {
    expect(chooseSteer({ ...base, exhausted: ['social/a', 'social/b'], elsewhere: [lane('video', 'x')], taken: ['video/x'] })).toBeNull()
  })
})

describe('graph', () => {
  test('separates verified, infringing and lookalike nodes, with no dangling edges', () => {
    const b = { ...initialBrand(), slug: 'tesla', officialDomains: ['tesla.com'], edges: [{ from: 'listing:https://tesla-x2.example', to: 'wallet:0xABC', kind: 'lead' }] }
    const g = buildGraph(b, [
      mk('bad', { state: 'awaiting_approval', hit: { ...hit, url: 'https://tesla-x2.example', lane: 'domains/l' } }),
      mk('real', { state: 'skipped', hit: { ...hit, url: 'https://shop.tesla.com/x' } }),
    ])
    const n = (id: string) => g.nodes.find(x => x.id === id)!
    expect(n('domain:tesla.com').trust).toBe('verified')
    expect(n('listing:https://tesla-x2.example').trust).toBe('infringing')
    expect(n('listing:https://shop.tesla.com/x').trust).toBe('verified')
    expect(n('wallet:0xABC').trust).toBe('suspect')
    expect(g.edges.some(e => e.kind === 'resembles' && e.to === 'domain:tesla.com')).toBe(true)
    const ids = new Set(g.nodes.map(x => x.id))
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true)
  })
})
