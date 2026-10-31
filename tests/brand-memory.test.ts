import { expect, test } from 'bun:test'
import { brand, initialBrand } from '../src/core/machines/brand'
import { webMemory } from '../src/harness/spiders'

test('a page remembers every hunt that came across it and keeps its first sighting', () => {
  let [s] = brand.markSeen(initialBrand(), 'https://x.example/a', { score: 0.2, state: 'triaged' }, 'h1', 100)
  ;[s] = brand.markSeen(s, 'https://x.example/a', { score: 0.9, state: 'verified' }, 'h1', 200)
  ;[s] = brand.notePage(s, 'https://x.example/a', 'h2', 300)
  expect(s.seen['https://x.example/a']).toEqual({ score: 0.9, state: 'verified', firstAt: 100, lastAt: 300, hunts: ['h1', 'h2'] })
})

test('a page nobody judged is not invented by a sighting', () => {
  const start = initialBrand()
  const [s, known] = brand.notePage(start, 'https://x.example/a', 'h1', 1)
  expect(known).toBe(false)
  expect(s).toBe(start)
})

test('a brand from before page history still reads', () => {
  const old = { ...initialBrand(), seen: { 'https://x.example/a': { score: 0.5, state: 'triaged' } } } as any
  const [s] = brand.notePage(old, 'https://x.example/a', 'h2', 5)
  // Older rows have no hunt list, but a hunt did find them, so this counts as a repeat.
  expect(s.seen['https://x.example/a']!.hunts).toEqual(['earlier', 'h2'])
})

test('searches are kept, even from a brand saved before they existed', () => {
  const { searches: _, ...old } = initialBrand()
  const [s] = brand.recordSearch(old as any, { huntId: 'h', scout: 'a', lane: 'l', at: 1, found: 3, fresh: 0, usd: 0.01 })
  expect(s.searches).toHaveLength(1)
})

test('the summary leaves out the history that grows', () => {
  const [s] = brand.markSeen(initialBrand(), 'https://x.example/a', { score: 0.2, state: 'triaged' })
  expect(brand.summary(s)[1].seen).toEqual({})
})

test('adopting the same source twice counts it once', () => {
  const other = { ...initialBrand(), hunts: 3, laneStats: { l: { tries: 2, hits: 1, costUsd: 0.5 } } }
  const [once, first] = brand.adopt(initialBrand(), 'file', other)
  const [twice, again] = brand.adopt(once, 'file', other)
  expect([first, again]).toEqual([true, false])
  expect(twice.hunts).toBe(3)
  expect(twice.laneStats.l!.tries).toBe(2)
})

test('a page from an earlier hunt is reported once as a repeat and stays out of the results', () => {
  const m = webMemory()
  m.restore(0, ['https://x.example/a'])
  const known: string[] = []
  const item = { url: 'https://x.example/a', title: '', snippet: '' }
  expect(m.fresh([item], u => known.push(u))).toEqual([])
  expect(m.fresh([item], u => known.push(u))).toEqual([])
  expect(known).toEqual(['https://x.example/a'])
})

test('a page seen earlier in this hunt is not a repeat', () => {
  const m = webMemory()
  const known: string[] = []
  const item = { url: 'https://x.example/b', title: '', snippet: '' }
  m.fresh([item], u => known.push(u))
  m.fresh([item], u => known.push(u))
  expect(known).toEqual([])
})
