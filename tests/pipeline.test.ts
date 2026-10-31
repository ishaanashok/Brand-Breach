import { expect, spyOn, test } from 'bun:test'
import { mockReasoner } from '../src/reasoners/mock'
import { mockDecider } from '../src/deciders/mock'
import { fallbackChain } from '../src/deciders/fallback'
import { caseId } from '../src/core/case-id'
import { parseTag } from '../src/core/tags'
import { MemoryBus } from '../src/relay/memory'
import { MemoryStore } from '../src/store/memory'
import { HuntRunner, type RunnerDeps } from '../src/harness/hunt-runner'
import { autoFallback, type Source } from '../src/harness/source'
import { liveSource } from '../src/harness/live'
import { loadTape, tapeSource } from '../src/harness/tape'
import type { Decider, HuntInput } from '../src/core/types'

const input: HuntInput = { brand: 'Tesla', keywords: ['giveaway'], officialDomains: ['tesla.com'], authorizedSellers: [], budgetUsd: 1, precision: 'balanced' }
const FAST = { scoutDelayMs: 1, tickMs: 5, cooldownMs: 30, verifyMs: 5 }

async function deps(store = new MemoryStore(), o: Partial<RunnerDeps> = {}, run = 1): Promise<RunnerDeps> {
  const tape = await loadTape()
  const d = fallbackChain([mockDecider()], { timeoutMs: 500 })
  return { store, bus: new MemoryBus(), source: tapeSource(tape, { run }), triage: d, verify: d, verifyEstUsd: 0.002, timing: FAST, ...o }
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await Bun.sleep(5) }
  return false
}

test('full tape hunt: drafts notices, steers with reasons, never overspends', async () => {
  const d = await deps()
  const r = new HuntRunner('h1', d)
  await r.start(input)
  expect(await until(async () => (await d.store.hunt('h1').snapshot()).status === 'done')).toBe(true)
  await r.stop()
  const h = await d.store.hunt('h1').snapshot()
  expect(Object.keys(h.roster).sort()).toEqual(['channels', 'domains', 'marketplace', 'social', 'video'])
  expect(h.spent).toBeLessThanOrEqual(1)
  expect(h.counters.verified).toBeGreaterThan(3)
  // The tape has the same page in several lanes, so racing scouts must collide.
  expect(h.counters.duplicates).toBeGreaterThan(0)
  const shared = caseId('tesla', 'https://tesla-x2-promo.example')
  expect((await d.store.kase(shared).snapshot()).reporters.length).toBeGreaterThan(1)
  expect(h.steers.length).toBeGreaterThan(0)
  for (const s of h.steers) expect(s.reason.length).toBeGreaterThan(5)
  const stages = await Promise.all(h.caseIds.map(id => d.store.kase(id).snapshot()))
  expect(stages.some(c => c.state === 'awaiting_approval' && c.notice!.includes('candidate'))).toBe(true)
  expect(stages.some(c => c.triage?.deciderId === 'mock-heuristic')).toBe(true)
  // Nothing on the tape reaches approval by itself.
  expect(stages.some(c => c.state === 'approved')).toBe(false)
})

test('lead hand-offs create graph edges and follow-up searches', async () => {
  const d = await deps()
  const r = new HuntRunner('h2', d)
  await r.start(input)
  await until(async () => (await d.store.hunt('h2').snapshot()).status === 'done')
  await r.stop()
  const bus = d.bus as MemoryBus
  const leads = bus.log.filter(m => parseTag(m.text)?.tag === 'LEAD')
  expect(leads.length).toBeGreaterThan(0)
  expect(leads.every(m => m.to.startsWith('@'))).toBe(true)
  const b = await d.store.brand('tesla').snapshot()
  expect(b.edges.some(e => e.to.startsWith('wallet:'))).toBe(true)
  expect(b.edges.some(e => e.to.startsWith('seller:'))).toBe(true)
  const followUp = caseId('tesla', 'https://tesla-x2-promo.example/claim')
  expect((await d.store.kase(followUp).snapshot()).state).not.toBe('empty')
})

test('approve and reject go through the case, label the brand, and only simulate a submit', async () => {
  const d = await deps()
  const r = new HuntRunner('h3', d)
  await r.start(input)
  await until(async () => (await d.store.hunt('h3').snapshot()).status === 'done')
  const snap = await d.store.hunt('h3').snapshot()
  const cases = await Promise.all(snap.caseIds.map(id => d.store.kase(id).snapshot()))
  const waiting = cases.filter(c => c.state === 'awaiting_approval')
  await r.decide(waiting[0]!.id, 'approve', 'ash')
  await r.decide(waiting[0]!.id, 'approve', 'ash')
  await r.decide(waiting[1]!.id, 'reject', 'ash')
  const h = await d.store.hunt('h3').snapshot()
  expect(h.counters.approved).toBe(1)
  expect(h.counters.rejected).toBe(1)
  expect((await d.store.kase(waiting[0]!.id).snapshot()).approval!.simulatedSubmit).toBe(true)
  expect((await d.store.brand('tesla').snapshot()).labels).toHaveLength(2)
  await r.stop()
})

test('budget too small for one search ends cleanly with zero spend', async () => {
  const d = await deps()
  const r = new HuntRunner('h4', d)
  await r.start({ ...input, budgetUsd: 0.0001 })
  expect(await until(async () => (await d.store.hunt('h4').snapshot()).status === 'budget_exhausted')).toBe(true)
  await r.stop()
  expect((await d.store.hunt('h4').snapshot()).spent).toBe(0)
})

test('a small budget stops the hunt at or under the limit', async () => {
  const d = await deps()
  const r = new HuntRunner('h5', d)
  await r.start({ ...input, budgetUsd: 0.01 })
  await until(async () => (await d.store.hunt('h5').snapshot()).status !== 'running')
  await r.stop()
  const h = await d.store.hunt('h5').snapshot()
  expect(h.spent).toBeLessThanOrEqual(0.01)
  expect(h.status).toBe('budget_exhausted')
})

test('all deciders failing marks cases undecided and the hunt survives', async () => {
  const bad: Decider = { ...mockDecider(), id: 'bad', decide: async () => { throw new Error('all deciders failed') } }
  const d = await deps(new MemoryStore(), { triage: bad, verify: bad })
  const r = new HuntRunner('h6', d)
  await r.start(input)
  expect(await until(async () => (await d.store.hunt('h6').snapshot()).status === 'done')).toBe(true)
  await r.stop()
  const h = await d.store.hunt('h6').snapshot()
  expect(h.counters.undecided).toBeGreaterThan(0)
  expect(h.counters.verified).toBe(0)
})

test('restart: a new runner resumes the hunt with lanes and cases intact', async () => {
  const store = new MemoryStore()
  const d1 = await deps(store)
  const r1 = new HuntRunner('h7', d1)
  await r1.start(input)
  await until(async () => (await store.hunt('h7').snapshot()).counters.seen > 3)
  await r1.stop()
  const before = await store.hunt('h7').snapshot()
  expect(before.status).toBe('running')
  const r2 = new HuntRunner('h7', await deps(store))
  await r2.resume()
  expect(await until(async () => (await store.hunt('h7').snapshot()).status === 'done')).toBe(true)
  await r2.stop()
  const after = await store.hunt('h7').snapshot()
  for (const id of before.caseIds) expect(after.caseIds).toContain(id)
  expect(after.counters.seen).toBeGreaterThanOrEqual(before.counters.seen)
})

test('restart: a case reported but never triaged before the crash still gets triaged', async () => {
  const store = new MemoryStore()
  const r1 = new HuntRunner('h8', await deps(store))
  await r1.start(input)
  await until(async () => (await store.hunt('h8').snapshot()).counters.seen > 0)
  await r1.stop()
  const hit = { url: 'https://stranded.example/free-tesla', surface: 'domains' as const, title: 'Free Tesla giveaway', snippet: 'Send crypto, claim your Tesla', lane: 'domains/x' }
  await store.kase('stranded').report('stranded', 'tesla', 'h8', hit, 'domains', Date.now())
  await store.hunt('h8').addCase('stranded')
  const r2 = new HuntRunner('h8', await deps(store))
  await r2.resume()
  expect(await until(async () => (await store.kase('stranded').snapshot()).state !== 'new')).toBe(true)
  await r2.stop()
})

test('a scout that loses the store for a moment comes back and the hunt finishes', async () => {
  const store = new MemoryStore()
  const realHunt = store.hunt.bind(store)
  let failures = 5
  store.hunt = id => {
    const h = realHunt(id)
    return new Proxy(h, { get: (t, k) => k === 'snapshot' && failures-- > 0 && failures < 3 ? () => Promise.reject(new Error('actor host is unavailable')) : (t as any)[k]?.bind?.(t) ?? (t as any)[k] })
  }
  const r = new HuntRunner('h9', await deps(store))
  await r.start(input)
  expect(await until(async () => (await realHunt('h9').snapshot()).status === 'done')).toBe(true)
  await r.stop()
  const h = await realHunt('h9').snapshot()
  expect(h.events.some(e => e.text.includes('crashed, restarting'))).toBe(true)
  expect(h.caseIds.length).toBeGreaterThan(10)
})

test('a decision on a finished hunt works from a runner that never joined the bus', async () => {
  const store = new MemoryStore()
  const r1 = new HuntRunner('h10', await deps(store))
  await r1.start(input)
  await until(async () => (await store.hunt('h10').snapshot()).status === 'done')
  await r1.stop()
  const s = await store.hunt('h10').snapshot()
  const cases = await Promise.all(s.caseIds.map(id => store.kase(id).snapshot()))
  const c = cases.find(x => x.state === 'awaiting_approval')!
  const fresh = new HuntRunner('h10', await deps(store))
  expect((await fresh.decide(c.id, 'approve', 'reviewer')).changed).toBe(true)
  expect((await store.kase(c.id).snapshot()).state).toBe('approved')
})

test('second run remembers lanes and reaches a verified finding for less', async () => {
  const store = new MemoryStore()
  // The verifier must outpace scouts here, or spend at first finding only measures timer order.
  const timing = { scoutDelayMs: 25, tickMs: 5, cooldownMs: 30, verifyMs: 2 }
  const d1 = await deps(store, { timing })
  const r1 = new HuntRunner('run1', d1)
  await r1.start(input)
  await until(async () => (await store.hunt('run1').snapshot()).status === 'done')
  await r1.stop()
  const d2 = await deps(store, { timing }, 2)
  const r2 = new HuntRunner('run2', d2)
  await r2.start(input)
  await until(async () => (await store.hunt('run2').snapshot()).status === 'done')
  await r2.stop()
  const a = await store.hunt('run1').snapshot()
  const b = await store.hunt('run2').snapshot()
  expect(b.firstVerifiedSpend).not.toBeNull()
  expect(b.firstVerifiedSpend!).toBeLessThan(a.firstVerifiedSpend!)
  expect(b.spent).toBeLessThan(a.spent)
  const assigned = (d2.bus as MemoryBus).log.map(m => parseTag(m.text)).filter(p => p?.tag === 'ASSIGN').map(p => p!.payload.lane.strategy)
  expect(assigned).toContain('giveaway-posts')
  expect(assigned).not.toContain('promo-accounts')
  // Remembered URLs are not triaged twice.
  expect(b.counters.triaged).toBeLessThan(a.counters.triaged)
})

test('source fallback switches to the tape when live returns too few', async () => {
  const tape = tapeSource(await loadTape())
  const dead: Source = { ...tape, id: 'live', search: async () => ({ hits: [], usd: 0 }) }
  let t = 0
  const reasons: string[] = []
  const s = autoFallback(dead, tape, { minHits: 5, withinMs: 30_000, now: () => t, onSwitch: x => reasons.push(x) })
  const lane = { source: 'video' as const, strategy: 'deepfake-streams', query: 'x' }
  expect((await s.search(lane)).hits).toHaveLength(0)
  t = 31_000
  expect((await s.search(lane)).hits.length).toBeGreaterThan(0)
  expect(s.active()).toBe('tape')
  expect(reasons).toHaveLength(1)
})

test('live source reads citations only and never fetches the cited page', async () => {
  const urls: string[] = []
  const f = (async (u: string) => {
    urls.push(u)
    return new Response(JSON.stringify({ output: [{ content: [{ text: 'A scam snippet', annotations: [{ type: 'url_citation', url: 'https://bad.example/x', title: 'Bad', start_index: 0, end_index: 6 }] }] }] }))
  }) as any
  const s = liveSource({ apiKey: 'k', fetch: f })
  const r = await s.search({ source: 'domains', strategy: 'lookalike-sites', query: 'tesla' })
  expect(r.hits[0]).toMatchObject({ url: 'https://bad.example/x', surface: 'domains', title: 'Bad' })
  expect(urls).toEqual(['https://api.openai.com/v1/responses'])
})

const kbFixture = { tesla: [
  { kind: 'account', value: 'chirp.example/tesla', confidence: 0.96, evidence: 'fixture' },
  { kind: 'seller', value: 'tesla-official-store', confidence: 0.9, evidence: 'fixture' },
  { kind: 'channel', value: 'msgr.example/s/tesla-owners-official', confidence: 0.86, evidence: 'fixture' },
  { kind: 'domain', value: 'teslaforum.example', confidence: 0.55, evidence: 'fixture' },
] }

test('knowledge base clears the real presences, and later hunts reuse it for free', async () => {
  const store = new MemoryStore()
  const reasoner = mockReasoner({ fixtures: kbFixture })
  const build = spyOn(reasoner, 'buildKb')
  const d = await deps(store, { reasoner })
  const r = new HuntRunner('kb1', d)
  await r.start(input)
  expect(await until(async () => (await store.hunt('kb1').snapshot()).status === 'done', 8000)).toBe(true)
  await r.stop()
  const kase = (url: string) => store.kase(caseId('tesla', url)).snapshot()
  expect((await kase('https://chirp.example/tesla/status/7')).skipReason).toContain('knowledge base')
  expect((await kase('https://shopnow.example/store/tesla-official/wall-connector')).skipReason).toContain('knowledge base')
  // Below the bar, so it is only a candidate and still gets examined.
  expect((await kase('https://teslaforum.example')).skipReason ?? '').not.toContain('knowledge base')
  const r2 = new HuntRunner('kb2', await deps(store, { reasoner }, 2))
  await r2.start(input)
  expect(await until(async () => (await store.hunt('kb2').snapshot()).status === 'done', 8000)).toBe(true)
  await r2.stop()
  expect(build).toHaveBeenCalledTimes(1)
})

test('a failed knowledge base build costs nothing and the hunt carries on', async () => {
  const reasoner = mockReasoner()
  reasoner.buildKb = async () => { throw new Error('boom') }
  const d = await deps(new MemoryStore(), { reasoner })
  const r = new HuntRunner('kb3', d)
  await r.start(input)
  expect(await until(async () => (await d.store.hunt('kb3').snapshot()).status === 'done', 8000)).toBe(true)
  await r.stop()
  const h = await d.store.hunt('kb3').snapshot()
  expect(h.events.some(e => e.text.includes('build failed'))).toBe(true)
  expect(h.counters.verified).toBeGreaterThan(0)
})

test('orchestrator spawns reasoners for what decisions could not settle, within budget', async () => {
  const failing: Decider = { ...mockDecider(), id: 'down', decide: async () => { throw new Error('decisions unavailable') } }
  const bus = new MemoryBus()
  const d = await deps(new MemoryStore(), { reasoner: mockReasoner({ fixtures: kbFixture }), verify: failing, bus })
  const r = new HuntRunner('sp1', d)
  await r.start({ ...input, budgetUsd: 0.2 })
  expect(await until(async () => (await d.store.hunt('sp1').snapshot()).status !== 'running', 8000)).toBe(true)
  await r.stop()
  const h = await d.store.hunt('sp1').snapshot()
  expect(h.spawns.length).toBeGreaterThan(0)
  expect(h.spawns.length).toBeLessThanOrEqual(8)
  expect(h.spawns.every(s => s.endedAt)).toBe(true)
  expect(h.spawns.some(s => s.trigger === 'undecided')).toBe(true)
  expect(h.spent).toBeLessThanOrEqual(0.2)
  const cases = await Promise.all(h.caseIds.map(id => d.store.kase(id).snapshot()))
  // A verify outage no longer means nothing reaches a person.
  expect(cases.some(c => c.state === 'awaiting_approval' && c.reasoning?.verdict === 'infringing')).toBe(true)
  expect(bus.log.some(m => m.text.startsWith('SPAWN '))).toBe(true)
  expect(bus.log.some(m => m.text.startsWith('VERDICT '))).toBe(true)
})

test('a reasoner that throws fails its case without hanging the hunt or keeping the money', async () => {
  const reasoner = mockReasoner({ usd: 0.01 })
  reasoner.assess = async () => { throw new Error('model down') }
  const d = await deps(new MemoryStore(), { reasoner })
  const r = new HuntRunner('sp2', d)
  await r.start(input)
  expect(await until(async () => (await d.store.hunt('sp2').snapshot()).status === 'done', 8000)).toBe(true)
  await r.stop()
  const h = await d.store.hunt('sp2').snapshot()
  expect(h.spawns.some(s => s.outcome === 'failed')).toBe(true)
  expect(Object.keys(h.reservations)).toEqual([])
})

test('a lane that only repeats itself stops being searched', async () => {
  const lane = { source: 'video' as const, strategy: 'same', query: 'q' }
  let calls = 0
  const source: Source = {
    id: 'loop', estUsd: 0.001,
    search: async l => { if (l.source !== 'video') return { hits: [], usd: 0.001 }; calls++; return { hits: [{ url: 'https://same.example', surface: 'video', title: 't', snippet: 's' }], usd: 0.001 } },
    followLead: async () => ({ hits: [], usd: 0 }),
    lanes: s => (s === 'video' ? [lane] : [{ ...lane, source: s, strategy: 'other' }]),
  }
  const d = await deps(new MemoryStore(), { source })
  const r = new HuntRunner('dry', d)
  r.start(input).catch(() => {})
  expect(await until(() => calls >= 3, 2000)).toBe(true)
  await Bun.sleep(100)
  const seen = calls
  await Bun.sleep(100)
  await d.store.hunt('dry').setStatus('done')
  await r.stop()
  expect(calls).toBe(seen)
})

test('a runner rebuilt after a restart still records a decision for the right brand', async () => {
  const store = new MemoryStore()
  const first = new HuntRunner('restarted', await deps(store))
  await first.start(input)
  await until(async () => (await store.hunt('restarted').snapshot()).status === 'done')
  await first.stop()
  const waiting = (await store.brandCases('tesla', 100)).find(c => c.state === 'awaiting_approval')!
  const rebuilt = new HuntRunner('restarted', await deps(store))
  expect((await rebuilt.decide(waiting.id, 'approve', 'reviewer')).changed).toBe(true)
  expect((await store.brand('tesla').snapshot()).labels.map(l => l.caseId)).toContain(waiting.id)
})
