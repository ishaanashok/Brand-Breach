import { afterAll, beforeAll, expect, test } from 'bun:test'
import { fallbackChain } from '../src/deciders/fallback'
import { mockDecider } from '../src/deciders/mock'
import { MemoryBus } from '../src/relay/memory'
import { loadTape, tapeSource } from '../src/harness/tape'
import { createServer, type App } from '../src/server/api'
import { MemoryStore } from '../src/store/memory'

let app: App
let base = ''
const post = (p: string, b: unknown = {}) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(b) })

beforeAll(async () => {
  const tape = await loadTape()
  const d = fallbackChain([mockDecider()], { timeoutMs: 500 })
  app = await createServer({
    port: 0, store: new MemoryStore(), mode: 'mock', verifyEstUsd: 0.002,
    timing: { scoutDelayMs: 1, tickMs: 5, cooldownMs: 30, verifyMs: 5 }, triage: d, verify: d,
    makeBus: async () => new MemoryBus(), makeSource: run => tapeSource(tape, { run }), feedMs: 10,
  })
  base = `http://127.0.0.1:${app.port}`
})
afterAll(() => app.stop())

const input = { brand: 'Tesla', keywords: ['giveaway'], officialDomains: ['tesla.com'], authorizedSellers: [], budgetUsd: 1, precision: 'balanced' }

test('rejects a bad setup without creating a hunt', async () => {
  expect((await post('/api/hunts', { ...input, brand: '' })).status).toBe(400)
  expect((await post('/api/hunts', { ...input, budgetUsd: -1 })).status).toBe(400)
  expect((await fetch(`${base}/api/hunts/nope`)).status).toBe(404)
})

test('hunt end to end over HTTP and socket, with redaction and versioned snapshots', async () => {
  const { id } = await (await post('/api/hunts', input)).json() as any
  const frames: any[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?hunt=${id}`)
  ws.onmessage = e => frames.push(JSON.parse(e.data as string))

  let view: any
  for (let i = 0; i < 400; i++) {
    view = await (await fetch(`${base}/api/hunts/${id}`)).json()
    if (view.hunt.status === 'done') break
    await Bun.sleep(10)
  }
  expect(view.hunt.status).toBe('done')
  await Bun.sleep(40)
  ws.close()
  expect(frames.length).toBeGreaterThan(0)
  const vs = frames.map(f => f.version)
  expect(vs).toEqual([...vs].sort((a, b) => a - b))

  const raw = JSON.stringify(view)
  expect(raw).not.toContain('0xFEED')
  expect(raw).not.toContain('musk_official_gift')

  const waiting = view.cases.filter((c: any) => c.state === 'awaiting_approval')
  expect(waiting.length).toBeGreaterThan(1)
  expect((await post(`/api/hunts/${id}/cases/${waiting[0].id}/decision`, { decision: 'maybe' })).status).toBe(400)
  expect((await post(`/api/hunts/${id}/cases/${waiting[0].id}/decision`, { decision: 'approve' })).status).toBe(200)
  const after: any = await (await fetch(`${base}/api/hunts/${id}/report`)).json()
  expect(after.totals.approved).toBe(1)
  expect(after.totals.costPerVerified).toBeGreaterThan(0)
  expect(Object.keys(after.bySurface).length).toBeGreaterThan(1)
  expect(after.perCase.length).toBeGreaterThan(1)
  expect(after.history.at(-1).id).toBe(id)
  expect(after.shadow.compared).toBe(0)
})

test('pause and budget controls', async () => {
  const { id } = await (await post('/api/hunts', { ...input, brand: 'Musk' })).json() as any
  expect((await post(`/api/hunts/${id}/control`, { action: 'pause' })).status).toBe(200)
  let v: any = await (await fetch(`${base}/api/hunts/${id}`)).json()
  expect(v.hunt.status).toBe('paused')
  await post(`/api/hunts/${id}/control`, { action: 'budget', usd: 2 })
  v = await (await fetch(`${base}/api/hunts/${id}`)).json()
  expect(v.hunt.input.budgetUsd).toBe(2)
  await post(`/api/hunts/${id}/control`, { action: 'resume' })
  expect((await post(`/api/hunts/${id}/control`, { action: 'bogus' })).status).toBe(400)
})
