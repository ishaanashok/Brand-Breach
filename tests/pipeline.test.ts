import { expect, test } from 'bun:test'
import { mockDecider } from '../src/deciders/mock'
import { fallbackChain } from '../src/deciders/fallback'
import { caseId } from '../src/core/canonical'
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

test('second run remembers lanes and reaches a verified finding for less', async () => {
  const store = new MemoryStore()
  const d1 = await deps(store)
  const r1 = new HuntRunner('run1', d1)
  await r1.start(input)
  await until(async () => (await store.hunt('run1').snapshot()).status === 'done')
  await r1.stop()
  const d2 = await deps(store, {}, 2)
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
