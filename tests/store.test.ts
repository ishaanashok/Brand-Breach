import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store/memory'

const input = { brand: 'Tesla', keywords: [], officialDomains: [], authorizedSellers: [], budgetUsd: 0.1, precision: 'balanced' as const }
const hit = { url: 'https://a.example/x', surface: 'video' as const, title: 't', snippet: 's' }

test('five simultaneous reports give one case and four duplicates', async () => {
  const c = new MemoryStore().kase('c1')
  const rs = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(n => c.report('c1', 'tesla', 'h', hit, n, 1)))
  expect(rs.filter(r => r.first)).toHaveLength(1)
  expect(rs.filter(r => !r.first)).toHaveLength(4)
})

test('five racing scouts cannot overspend', async () => {
  const h = new MemoryStore().hunt('h')
  await h.init('h', input, 0)
  await Promise.all(Array.from({ length: 5 }, (_, i) => (async () => {
    for (let n = 0; n < 50; n++) {
      const r = await h.reserve(`s${i}`, 0.01, n)
      if (r.ok) await h.settle(r.id!, 0.01)
    }
  })()))
  const s = await h.snapshot()
  expect(s.spent).toBeLessThanOrEqual(0.1 + 1e-9)
  expect(s.spent).toBeCloseTo(0.1)
})

test('file backed state survives a new store, like a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customs-'))
  const a = new MemoryStore(dir)
  await a.hunt('h').init('h', input, 0)
  await a.hunt('h').bump('seen', 3)
  await a.playbook().registerHunt('h')
  const b = new MemoryStore(dir)
  expect((await b.hunt('h').snapshot()).counters.seen).toBe(3)
  expect(await b.playbook().listHunts()).toEqual(['h'])
})
