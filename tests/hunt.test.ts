import { expect, test } from 'bun:test'
import { hunt, initialHunt, type HuntState } from '../src/core/machines/hunt'

const input = {
  brand: 'Tesla', keywords: ['giveaway'], officialDomains: ['tesla.com'],
  authorizedSellers: [], budgetUsd: 1, precision: 'balanced' as const,
}
const fresh = (): HuntState => hunt.init(initialHunt(), 'h1', input, 0)[0]

test('init saves every setup field', () => {
  const s = fresh()
  expect(s.input).toEqual(input)
  expect(s.status).toBe('running')
  expect(s.version).toBeGreaterThan(0)
})

test('never over-reserves under random interleavings', () => {
  let s = fresh()
  const open: string[] = []
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 2000; i++) {
    if (rnd() < 0.6) {
      const [n, r] = hunt.reserve(s, `s${i % 5}`, rnd() * 0.05, i)
      s = n
      if (r.ok) open.push(r.id!)
    } else if (open.length) {
      s = hunt.settle(s, open.splice(Math.floor(rnd() * open.length), 1)[0]!, rnd() * 0.1)[0]
    }
    expect(s.spent + reservedTotal(s)).toBeLessThanOrEqual(s.input!.budgetUsd + 1e-9)
  }
})

const reservedTotal = (s: HuntState) => Object.values(s.reservations).reduce((a, r) => a + r.usd, 0)

test('settling releases the difference', () => {
  let s = fresh()
  const [a, r] = hunt.reserve(s, 'x', 0.5, 0)
  s = hunt.settle(a, r.id!, 0.1)[0]
  expect(s.spent).toBeCloseTo(0.1)
  expect(reservedTotal(s)).toBe(0)
})

test('an actual cost above the reservation is capped and counted', () => {
  let s = fresh()
  const [a, r] = hunt.reserve(s, 'x', 0.9, 0)
  s = hunt.settle(a, r.id!, 5)[0]
  expect(s.spent).toBe(1)
  expect(s.overshootPreventedUsd).toBeCloseTo(4)
})

test('settling twice does not double count', () => {
  let s = fresh()
  const [a, r] = hunt.reserve(s, 'x', 0.5, 0)
  s = hunt.settle(a, r.id!, 0.2)[0]
  s = hunt.settle(s, r.id!, 0.2)[0]
  expect(s.spent).toBeCloseTo(0.2)
})

test('a crashed scout reservation expires and returns budget', () => {
  const [a] = hunt.reserve(fresh(), 'x', 1, 0)
  expect(hunt.reserve(a, 'y', 0.5, 1000)[1].ok).toBe(false)
  expect(hunt.reserve(a, 'y', 0.5, 61_000)[1].ok).toBe(true)
})

test('a budget too small for one call stops the hunt with zero spend', () => {
  const s0 = hunt.init(initialHunt(), 'h', { ...input, budgetUsd: 0.0001 }, 0)[0]
  const [s, r] = hunt.reserve(s0, 'x', 0.01, 0)
  expect(r).toMatchObject({ ok: false, reason: 'budget_exhausted' })
  expect(s.status).toBe('budget_exhausted')
  expect(s.spent).toBe(0)
})

test('paused and stopped hunts refuse reservations', () => {
  const p = hunt.setStatus(fresh(), 'paused')[0]
  expect(hunt.reserve(p, 'x', 0.01, 0)[1]).toMatchObject({ ok: false, reason: 'paused' })
})

test('raising the budget revives an exhausted hunt', () => {
  const [s] = hunt.reserve(hunt.init(initialHunt(), 'h', { ...input, budgetUsd: 0 }, 0)[0], 'x', 0.01, 0)
  const n = hunt.setBudget(s, 1)[0]
  expect(n.status).toBe('running')
})

test('budget cannot be lowered below what is committed', () => {
  const [a] = hunt.reserve(fresh(), 'x', 0.5, 0)
  expect(hunt.setBudget(a, 0.1)[0].input!.budgetUsd).toBeCloseTo(0.5)
})

test('roster, lanes, counters and version', () => {
  let s = fresh()
  const lane = { source: 'video' as const, strategy: 'giveaway', query: 'tesla' }
  s = hunt.registerScout(s, 'video', lane, 1)[0]
  s = hunt.registerScout(s, 'video', lane, 2)[0]
  expect(Object.keys(s.roster)).toEqual(['video'])
  const v = s.version
  s = hunt.bump(s, 'seen', 2)[0]
  expect(s.counters.seen).toBe(2)
  expect(s.version).toBe(v + 1)
  s = hunt.setLane(s, 'video', { ...lane, strategy: 'deepfake' }, 'low yield', 5)[0]
  expect(s.roster.video!.lane.strategy).toBe('deepfake')
  expect(s.steers.at(-1)).toMatchObject({ scout: 'video', reason: 'low yield' })
})

test('addCase dedupes and event log is bounded', () => {
  let s = fresh()
  s = hunt.addCase(s, 'c1')[0]
  s = hunt.addCase(s, 'c1')[0]
  expect(s.caseIds).toEqual(['c1'])
  for (let i = 0; i < 500; i++) s = hunt.log(s, `e${i}`, i)[0]
  expect(s.events.length).toBeLessThanOrEqual(200)
})
