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

test('graph and knowledge base APIs: query, add, refuse a platform, remove', async () => {
  const res = await post('/api/hunts', { ...input, brand: 'KbBrand', officialDomains: ['kbbrand.example'] })
  const { id } = await res.json() as any
  const until = async () => { for (let i = 0; i < 200; i++) { const v: any = await (await fetch(`${base}/api/hunts/${id}`)).json(); if (v.hunt?.caseIds.length) return v; await Bun.sleep(10) } throw new Error('no cases') }
  const v = await until()
  expect(v.graph.nodes.some((n: any) => n.id === 'domain:kbbrand.example' && n.trust === 'verified')).toBe(true)
  const kb = '/api/brands/kbbrand/kb'
  expect((await post(kb, { action: 'add', kind: 'domain', value: 'youtube.com' })).status).toBe(400)
  expect((await post(kb, { action: 'add', kind: 'account', value: 'chirp.example/kbbrand' })).status).toBe(200)
  let list: any = await (await fetch(`${base}${kb}`)).json()
  expect(list.entities.find((e: any) => e.id === 'account:chirp.example/kbbrand').source).toBe('human')
  await post(kb, { action: 'remove', id: 'account:chirp.example/kbbrand' })
  list = await (await fetch(`${base}${kb}`)).json()
  expect(list.entities.some((e: any) => e.id === 'account:chirp.example/kbbrand')).toBe(false)
  const g: any = await (await fetch(`${base}/api/brands/kbbrand/graph?node=${encodeURIComponent('domain:kbbrand.example')}`)).json()
  expect(g.nodes.length).toBeGreaterThanOrEqual(2)
  expect(g.edges.every((e: any) => e.from === 'domain:kbbrand.example' || e.to === 'domain:kbbrand.example')).toBe(true)
  expect((await fetch(`${base}/api/brands/nobody/graph`)).status).toBe(404)
})

test('a finished hunt refuses controls, but its cases can still be decided', async () => {
  const { id } = await (await post('/api/hunts', { ...input, brand: 'Finished' })).json() as any
  let v: any
  for (let i = 0; i < 400; i++) {
    v = await (await fetch(`${base}/api/hunts/${id}`)).json()
    if (v.hunt.status === 'done') break
    await Bun.sleep(10)
  }
  expect(v.hunt.status).toBe('done')
  for (const b of [{ action: 'pause' }, { action: 'resume' }, { action: 'budget', usd: 5 }]) {
    const r = await post(`/api/hunts/${id}/control`, b)
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error).toContain('finished')
  }
  expect(((await (await fetch(`${base}/api/hunts/${id}`)).json()) as any).hunt.status).toBe('done')
})

test('resume is refused unless paused, and a lowered budget reports what it became', async () => {
  const { id } = await (await post('/api/hunts', { ...input, brand: 'Limits', budgetUsd: 50 })).json() as any
  expect((await post(`/api/hunts/${id}/control`, { action: 'resume' })).status).toBe(409)
  await post(`/api/hunts/${id}/control`, { action: 'pause' })
  const r: any = await (await post(`/api/hunts/${id}/control`, { action: 'budget', usd: 40 })).json()
  expect(r.budgetUsd).toBe(40)
})

test('the hunt list says what each hunt was, the config says what is billed, and lanes are listed', async () => {
  const { id } = await (await post('/api/hunts', { ...input, brand: 'Listed' })).json() as any
  const l: any = await (await fetch(`${base}/api/hunts`)).json()
  expect(l.summaries.find((h: any) => h.id === id).brand).toBe('Listed')
  expect(((await (await fetch(`${base}/api/config`)).json()) as any).billed).toEqual([])
  const lanes: any = await (await fetch(`${base}/api/hunts/${id}/lanes`)).json()
  expect(lanes.lanes.social.length).toBeGreaterThan(0)
})
