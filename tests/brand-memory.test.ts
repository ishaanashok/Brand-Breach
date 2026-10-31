import { expect, test } from 'bun:test'
import { brand, initialBrand, searchHistory, type QueryOutcome } from '../src/core/machines/brand'
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

const NOW = 100 * 24 * 60 * 60 * 1000
const ran = (queries: QueryOutcome[], at = NOW) => ({ huntId: 'h', scout: 'a', lane: 'l', at, found: 0, fresh: 0, usd: 0, queries })

test('history sorts earlier searches by how they went, and the latest outcome counts', () => {
  const s = { ...initialBrand(), searches: [
    ran([{ query: 'fake acme', found: 5, fresh: 5 }, { query: 'acme outlet', found: 5, fresh: 1 }, { query: 'acme deals', found: 4, fresh: 3 }]),
    ran([{ query: 'Acme Outlet', found: 5, fresh: 0 }]),
  ] }
  const h = searchHistory(s, NOW)
  expect(h.worked).toEqual(['fake acme', 'acme deals'])
  expect(h.dry).toEqual(['Acme Outlet'])
})

test('a search with no results is not dry, because an outage looks the same', () => {
  expect(searchHistory({ ...initialBrand(), searches: [ran([{ query: 'q', found: 0, fresh: 0 }])] }, NOW)).toEqual({ dry: [], worked: [], sites: [] })
})

test('an old dry search gets another try, and a brand with no queries still reads', () => {
  const s = { ...initialBrand(), searches: [ran([{ query: 'q', found: 2, fresh: 0 }], 0), { huntId: 'h', scout: 'a', lane: 'l', at: NOW, found: 1, fresh: 1, usd: 0 }] }
  expect(searchHistory(s, NOW).dry).toEqual([])
})

test('sites rank by flagged pages, and pages that were cleared do not count', () => {
  const page = (state: string) => ({ score: 0.9, state, firstAt: 0, lastAt: 0, hunts: [] })
  const s = { ...initialBrand(), seen: {
    'https://a.example/1': page('verified'),
    'https://www.b.example/1': page('awaiting_approval'),
    'https://www.b.example/2': page('approved'),
    'https://c.example/1': page('cleared'),
    'not a url': page('verified'),
  } }
  expect(searchHistory(s, NOW).sites).toEqual(['b.example', 'a.example'])
})
