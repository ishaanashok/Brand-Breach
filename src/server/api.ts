import type { ServerWebSocket } from 'bun'
import { buildGraph, type Graph } from '../core/graph'
import { entityFrom, kbEntities, type KbKind } from '../core/kb'
import { redactDeep, sensitiveTerms } from '../core/redact'
import { buildReport } from '../core/report'
import { encodeTag } from '../core/tags'
import { SURFACES, slug, type Decider, type HuntInput, type Surface } from '../core/types'
import { HuntRunner, type Timing } from '../harness/hunt-runner'
import type { Source } from '../harness/source'
import type { Reasoner } from '../reasoners/types'
import type { Bus } from '../relay/types'
import type { Store } from '../store/types'

const RESUME_TRIES = 12
const RESUME_WAIT_MS = 5000

export type AppConfig = {
  port: number; store: Store; mode: string; verifyEstUsd: number; timing: Timing
  triage: Decider; verify: Decider; reasoner?: Reasoner
  makeBus: (huntId: string) => Promise<Bus>
  makeSource: (run: number, huntId: string, input: HuntInput) => Source
  /** Where results come from: spiders, live or the recorded tape. */
  source?: string
  feedMs?: number
  /** Fallback and shadow events from the decider layer. */
  deciderLog?: DeciderLog
  /** What this configuration pays a provider for; empty means the budget only counts simulated costs. */
  billed?: string[]
}
export type DeciderLog = { fallbacks: { at: number; from: string; error: string }[]; shadow: { agreed: boolean }[] }
export type App = { port: number; stop(): void; resumeAll(): Promise<string[]> }

const PUBLIC = new URL('../../public/', import.meta.url).pathname
const json = (b: unknown, status = 200) => Response.json(b, { status })

function parseInput(b: any): HuntInput | null {
  if (typeof b?.brand !== 'string' || !slug(b.brand)) return null
  if (typeof b.budgetUsd !== 'number' || !(b.budgetUsd > 0)) return null
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter(s => typeof s === 'string' && s.trim()).map((s: string) => s.trim()) : [])
  return {
    brand: b.brand.trim(), keywords: strs(b.keywords), officialDomains: strs(b.officialDomains), authorizedSellers: strs(b.authorizedSellers),
    budgetUsd: b.budgetUsd, ...(Number.isInteger(b.maxSearches) && b.maxSearches > 0 ? { maxSearches: Math.min(b.maxSearches, 500) } : {}), precision: ['precision', 'recall'].includes(b.precision) ? b.precision : 'balanced',
  }
}

export async function createServer(cfg: AppConfig): Promise<App> {
  const { store } = cfg
  const runners = new Map<string, HuntRunner>()
  const sockets = new Map<string, Set<ServerWebSocket<{ hunt: string }>>>()

  const deps = async (huntId: string, run: number, input: HuntInput) => ({
    store, bus: await cfg.makeBus(huntId), source: cfg.makeSource(run, huntId, input),
    triage: cfg.triage, verify: cfg.verify, verifyEstUsd: cfg.verifyEstUsd, timing: cfg.timing, reasoner: cfg.reasoner,
  })

  /** What every viewer sees: built only from actor snapshots, with handles and wallets blurred. */
  async function view(id: string) {
    const hunt = await store.hunt(id).snapshot()
    if (!hunt.input) return null
    const [cases, brand] = await Promise.all([
      store.cases(hunt.caseIds),
      store.brand(slug(hunt.input.brand)).snapshot(),
    ])
    return { hunt, cases, brand }
  }
  /** Infringers' handles are blurred on screen; a brand's own verified names are public by definition. */
  const termsFor = (cases: Parameters<typeof sensitiveTerms>[0], b: Parameters<typeof kbEntities>[0] & { edges: { to: string }[] }) => {
    const own = new Set(kbEntities(b).filter(e => e.status === 'verified').map(e => e.value))
    return sensitiveTerms(cases, b.edges).filter(t => !own.has(t.toLowerCase()))
  }
  const publicView = async (id: string) => {
    const v = await view(id)
    if (!v) return null
    return redactDeep({
      version: v.hunt.version + v.cases.reduce((a, c) => a + c.version, 0) + v.brand.version,
      hunt: v.hunt, cases: v.cases,
      graph: buildGraph(v.brand, v.cases, v.hunt), kb: { entities: kbEntities(v.brand), builtBy: v.brand.kb?.builtBy ?? null, builtAt: v.brand.kb?.builtAt ?? null }, lanes: v.brand.laneStats, thresholds: v.brand.thresholds, labels: v.brand.labels.length,
      fallbacks: cfg.deciderLog?.fallbacks.slice(-20) ?? [],
      priorHunts: v.brand.hunts - 1, disclaimer: 'Candidates flagged for review.',
    }, termsFor(v.cases, v.brand))
  }

  const server = Bun.serve<{ hunt: string }>({
    port: cfg.port,
    // Joining Relay can outlast the 10s default while a busy workspace is backing off.
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const p = url.pathname
      if (p === '/ws') {
        const hunt = url.searchParams.get('hunt') ?? ''
        return srv.upgrade(req, { data: { hunt } }) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      if (p.startsWith('/api/')) return route(req, p).catch(err => json({ error: String(err) }, 500))
      const file = Bun.file(`${PUBLIC}${p === '/' ? 'index.html' : p.replace(/\.\./g, '')}`)
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        const set = sockets.get(ws.data.hunt) ?? new Set()
        set.add(ws)
        sockets.set(ws.data.hunt, set)
        lastSent.delete(ws.data.hunt)
      },
      close(ws) { sockets.get(ws.data.hunt)?.delete(ws) },
      message() {},
    },
  })

  const lastSent = new Map<string, number>()
  const feed = setInterval(async () => {
    for (const [id, set] of sockets) {
      if (!set.size) continue
      const v = await publicView(id).catch(() => null)
      if (!v || lastSent.get(id) === v.version) continue
      lastSent.set(id, v.version)
      const text = JSON.stringify(v)
      for (const ws of set) ws.send(text)
    }
  }, cfg.feedMs ?? 400)

  async function route(req: Request, p: string): Promise<Response> {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null
    if (p === '/api/config') return json({ mode: cfg.mode, triage: cfg.triage.id, verify: cfg.verify.id, reasoner: cfg.reasoner?.id ?? null, surfaces: SURFACES, billed: cfg.billed ?? [], source: cfg.source ?? 'tape' })
    if (p === '/api/hunts' && req.method === 'GET') {
      const hunts = await store.playbook().listHunts()
      const snaps = await Promise.all(hunts.map(h => store.hunt(h).snapshot()))
      const summaries = snaps.filter(h => h.input).sort((a, b) => b.startedAt - a.startedAt)
        .map(h => ({ id: h.id, brand: h.input!.brand, status: h.status, startedAt: h.startedAt, spentUsd: h.spent, budgetUsd: h.input!.budgetUsd, verified: h.counters.verified }))
      return json({ hunts, summaries })
    }
    if (p === '/api/hunts' && req.method === 'POST') {
      const input = parseInput(body)
      if (!input) return json({ error: 'brand and a positive budget are required' }, 400)
      const id = `hunt_${crypto.randomUUID().slice(0, 8)}`
      const prior = (await store.brand(slug(input.brand)).summary()).hunts
      const r = new HuntRunner(id, await deps(id, prior + 1, input))
      runners.set(id, r)
      await r.start(input)
      return json({ id })
    }
    const br = p.match(/^\/api\/brands\/([\w-]+)\/(kb|graph|memory)$/)
    if (br) return brandRoute(req, br[1]!, br[2]!, body)
    const m = p.match(/^\/api\/hunts\/([\w-]+)(?:\/(.+))?$/)
    if (!m) return json({ error: 'not found' }, 404)
    const [, id, rest] = m as unknown as [string, string, string | undefined]
    const v = await view(id)
    if (!v) return json({ error: 'unknown hunt' }, 404)
    if (!rest) return json(await publicView(id))
    if (rest === 'report') {
      const peers = await Promise.all((await store.playbook().listHunts()).map(h => store.hunt(h).snapshot()))
      const history = peers
        .filter(p => p.input && slug(p.input.brand) === slug(v.hunt.input!.brand) && p.startedAt <= v.hunt.startedAt)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(p => ({ id: p.id, spentUsd: p.spent, verified: p.counters.verified, firstVerifiedSpendUsd: p.firstVerifiedSpend, secondsToFirstVerified: p.firstVerifiedAt ? (p.firstVerifiedAt - p.startedAt) / 1000 : null }))
      const shadow = cfg.deciderLog?.shadow ?? []
      const disagreementRate = shadow.length ? shadow.filter(s => !s.agreed).length / shadow.length : null
      return json(redactDeep({ ...buildReport(v.hunt, v.cases), history, shadow: { compared: shadow.length, disagreementRate }, fallbacks: cfg.deciderLog?.fallbacks.length ?? 0, laneStats: v.brand.laneStats }, sensitiveTerms(v.cases, v.brand.edges)))
    }

    if (rest === 'lanes') {
      const source = cfg.makeSource(1, id, v.hunt.input!)
      return json({ lanes: Object.fromEntries(SURFACES.map(s => [s, source.lanes(s, v.hunt.input!.keywords).map(l => l.strategy)])) })
    }

    const hunt = store.hunt(id)
    if (rest === 'control' && body) {
      const r = runners.get(id)
      const status = v.hunt.status
      // A finished hunt has no scouts left, so these would only change the label on the screen.
      if (status === 'done') return json({ error: 'This hunt has finished. Start a new one to search again.' }, 409)
      if (body.action === 'pause' && status !== 'running') return json({ error: `A hunt that is ${status.replace('_', ' ')} cannot be paused.` }, 409)
      if (body.action === 'resume' && status !== 'paused') return json({ error: 'Only a paused hunt can be resumed.' }, 409)
      const say = (scout: string, text: string) => r?.humanSay(`@${scout}`, text).catch(() => {})
      switch (body.action) {
        case 'pause': await hunt.setStatus('paused'); break
        case 'resume': await hunt.setStatus('running'); break
        case 'budget':
          if (!(body.usd > 0)) return json({ error: 'usd must be positive' }, 400)
          return json({ ok: true, budgetUsd: await hunt.setBudget(body.usd) })
        case 'boost': {
          const scout = body.scout as Surface
          const lane = SURFACES.includes(scout) ? cfg.makeSource(1, id, v.hunt.input!).lanes(scout, v.hunt.input!.keywords).find(l => l.strategy === body.strategy) : null
          if (!lane) return json({ error: 'unknown lane' }, 400)
          if (!r) return json({ error: 'This hunt is not running on this server.' }, 409)
          await say(scout, encodeTag('STEER', { lane, reason: 'boosted by the reviewer' }))
          break
        }
        default: return json({ error: 'unknown action' }, 400)
      }
      return json({ ok: true })
    }
    const dec = rest.match(/^cases\/([\w-]+)\/(decision|recheck)$/)
    if (dec && body) {
      const [, caseId, what] = dec as unknown as [string, string, string]
      if (!v.hunt.caseIds.includes(caseId)) return json({ error: 'unknown case' }, 404)
      if (what === 'recheck') {
        await store.kase(caseId).recheck(body.result === 'relisted' ? 'relisted' : 'resolved', Date.now())
        return json({ ok: true })
      }
      if (body.decision !== 'approve' && body.decision !== 'reject') return json({ error: 'decision must be approve or reject' }, 400)
      const r = runners.get(id) ?? new HuntRunner(id, await deps(id, 1, v.hunt.input!))
      return json(await r.decide(caseId, body.decision, 'reviewer'))
    }
    return json({ error: 'not found' }, 404)
  }

  /** The graph across every hunt for a brand, with an optional focus on one node's neighbours. */
  async function brandRoute(req: Request, brandSlug: string, what: string, body: any): Promise<Response> {
    const client = store.brand(brandSlug)
    const b = await client.snapshot()
    if (!b.slug) return json({ error: 'unknown brand' }, 404)
    if (what === 'memory') {
      const pages = Object.entries(b.seen).map(([url, p]) => ({ url, ...p }))
      return json(redactDeep({
        hunts: b.hunts, lanes: b.laneStats, searches: b.searches,
        pages: pages.length,
        repeatPages: pages.filter(p => (p.hunts?.length ?? 0) > 1),
        byState: pages.reduce<Record<string, number>>((n, p) => ({ ...n, [p.state]: (n[p.state] ?? 0) + 1 }), {}),
        links: b.edges.length,
      }, termsFor([], b)))
    }
    if (what === 'kb') {
      if (req.method === 'POST') {
        if (body?.action === 'remove' && typeof body.id === 'string') { await client.removeKbEntity(body.id); return json({ ok: true }) }
        const e = body?.action === 'add' && ['domain', 'account', 'seller', 'channel'].includes(body.kind) && typeof body.value === 'string'
          ? entityFrom(body.kind as KbKind, body.value, 'human', 1, 'Added by the reviewer') : null
        if (!e) return json({ error: "That can't be marked as real. Use a website the brand owns, or host/path for an account on a shared platform." }, 400)
        await client.addKbEntity(e)
        return json({ ok: true, entity: e })
      }
      return json({ entities: kbEntities(b), builtBy: b.kb?.builtBy ?? null, builtAt: b.kb?.builtAt ?? null })
    }
    const hunts = (await Promise.all((await store.playbook().listHunts()).map(h => store.hunt(h).snapshot())))
      .filter(h => h.input && slug(h.input.brand) === brandSlug)
    const cases = await store.cases([...new Set(hunts.flatMap(h => h.caseIds))])
    const graph = buildGraph(b, cases)
    const node = new URL(req.url).searchParams.get('node')
    const focus = (g: Graph): Graph => {
      const edges = g.edges.filter(e => e.from === node || e.to === node)
      const ids = new Set([node, ...edges.flatMap(e => [e.from, e.to])])
      return { nodes: g.nodes.filter(n => ids.has(n.id)), edges }
    }
    return json(redactDeep(node ? focus(graph) : graph, termsFor(cases, b)))
  }

  return {
    port: server.port!,
    stop() {
      clearInterval(feed)
      server.stop(true)
      for (const r of runners.values()) r.stop().catch(() => {})
    },
    /** Rebuilds a runner for every running hunt the Playbook remembers. */
    async resumeAll() {
      const resumed: string[] = []
      // Hunts resume side by side, and retry while the actor runtime comes back.
      await Promise.all((await store.playbook().listHunts()).map(async id => {
        for (let tries = RESUME_TRIES; tries > 0; tries--) {
          let r: HuntRunner | undefined
          try {
            const h = await store.hunt(id).snapshot()
            if (h.status !== 'running' && h.status !== 'paused') return
            const prior = (await store.brand(slug(h.input!.brand)).summary()).hunts
            r = new HuntRunner(id, await deps(id, Math.max(prior, 1), h.input!))
            await r.resume()
            runners.set(id, r)
            resumed.push(id)
            return
          } catch (err) {
            await r?.stop().catch(() => {})
            console.error(`[customs] could not resume ${id}: ${err}`)
            await Bun.sleep(RESUME_WAIT_MS)
          }
        }
      }))
      return resumed
    },
  }
}
