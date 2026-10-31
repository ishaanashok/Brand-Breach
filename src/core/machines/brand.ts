import { emptyKb, mergeKb, type BrandKb, type KbEntity } from '../kb.js'
import type { Step } from '../types.js'

export type LaneStat = { tries: number; hits: number; costUsd: number }
export type Edge = { from: string; to: string; kind: string }
/** Stands in for the hunts before pages kept this history. */
export const EARLIER_HUNT = 'earlier'
/** A page's latest outcome, and every hunt that came across it. */
export type PageMemory = { score: number; state: string; firstAt: number; lastAt: number; hunts: string[] }
/** One search by one agent, so later hunts can see what paid off and what came back empty. */
export type SearchRecord = { huntId: string; scout: string; lane: string; at: number; found: number; fresh: number; usd: number; failed?: boolean }
export type Label = { caseId: string; url: string; decision: 'approve' | 'reject'; deciderId: string; score: number; seller?: string }

export type BrandState = {
  version: number
  slug: string
  officialDomains: string[]
  authorizedSellers: string[]
  whitelist: string[]
  labels: Label[]
  seen: Record<string, PageMemory>
  edges: Edge[]
  searches: SearchRecord[]
  laneStats: Record<string, LaneStat>
  thresholds: Record<string, number>
  hunts: number
  kb: BrandKb
  /** Where past data was brought in from, so nothing is counted twice. */
  adopted?: string[]
}

export const DEFAULT_THRESHOLD = 0.5
const STEP = 0.02

export const initialBrand = (): BrandState => ({
  version: 0, slug: '', officialDomains: [], authorizedSellers: [], whitelist: [], labels: [],
  seen: {}, edges: [], searches: [], laneStats: {}, thresholds: {}, hunts: 0, kb: emptyKb(),
})

const v = (s: BrandState, patch: Partial<BrandState>): BrandState => ({ ...s, ...patch, version: s.version + 1 })
const clamp = (x: number) => Math.min(0.95, Math.max(0.05, x))

export const brand = {
  configure(s: BrandState, slug: string, officialDomains: string[], authorizedSellers: string[]): Step<BrandState, BrandState> {
    const next = v(s, {
      slug,
      officialDomains: [...new Set([...s.officialDomains, ...officialDomains])],
      authorizedSellers: [...new Set([...s.authorizedSellers, ...authorizedSellers])],
      hunts: s.hunts + 1,
    })
    return [next, next]
  },
  addEdges(s: BrandState, edges: Edge[]): Step<BrandState, number> {
    const key = (e: Edge) => `${e.from}|${e.to}|${e.kind}`
    const have = new Set(s.edges.map(key))
    const add: Edge[] = []
    for (const e of edges) if (!have.has(key(e))) { have.add(key(e)); add.push(e) }
    return add.length ? [v(s, { edges: [...s.edges, ...add] }), add.length] : [s, 0]
  },
  recordLaneOutcome(s: BrandState, lane: string, d: LaneStat): Step<BrandState, LaneStat> {
    const p = s.laneStats[lane] ?? { tries: 0, hits: 0, costUsd: 0 }
    const n = { tries: p.tries + d.tries, hits: p.hits + d.hits, costUsd: p.costUsd + d.costUsd }
    return [v(s, { laneStats: { ...s.laneStats, [lane]: n } }), n]
  },
  addLabel(s: BrandState, l: Label): Step<BrandState, boolean> {
    if (s.labels.some(x => x.caseId === l.caseId)) return [s, false]
    const t = s.thresholds[l.deciderId] ?? DEFAULT_THRESHOLD
    // A rejected flag means the threshold was too loose; an approval lets it relax a little.
    const thresholds = { ...s.thresholds, [l.deciderId]: clamp(t + (l.decision === 'reject' ? STEP : -STEP / 2)) }
    const whitelist = l.decision === 'reject' && l.seller && !s.whitelist.includes(l.seller)
      ? [...s.whitelist, l.seller] : s.whitelist
    return [v(s, { labels: [...s.labels, l], thresholds, whitelist }), true]
  },
  markSeen(s: BrandState, url: string, r: { score: number; state: string }, huntId = '', now = 0): Step<BrandState, null> {
    const p = s.seen[url]
    const hunts = p ? p.hunts ?? [EARLIER_HUNT] : []
    const page: PageMemory = { ...r, firstAt: p?.firstAt ?? now, lastAt: now, hunts: !huntId || hunts.includes(huntId) ? hunts : [...hunts, huntId] }
    return [v(s, { seen: { ...s.seen, [url]: page } }), null]
  },
  getSeen(s: BrandState, url: string): Step<BrandState, PageMemory | null> {
    return [s, s.seen[url] ?? null]
  },
  /** A later hunt came across a page already judged. Its outcome stands, and the sighting is kept. */
  notePage(s: BrandState, url: string, huntId: string, now: number): Step<BrandState, boolean> {
    const p = s.seen[url]
    if (!p) return [s, false]
    const earlier = p.hunts ?? [EARLIER_HUNT]
    const hunts = earlier.includes(huntId) ? earlier : [...earlier, huntId]
    return [v(s, { seen: { ...s.seen, [url]: { ...p, lastAt: now, hunts } } }), true]
  },
  recordSearch(s: BrandState, r: SearchRecord): Step<BrandState, null> {
    return [v(s, { searches: [...(s.searches ?? []), r] }), null]
  },
  /** Everything except the page and search history, which grow with every hunt. */
  summary(s: BrandState): Step<BrandState, BrandState> {
    return [s, { ...s, seen: {}, edges: [], searches: [] }]
  },
  /** Folds in what an older store learned about this brand. What this brand already has wins. */
  adopt(s: BrandState, source: string, o: BrandState): Step<BrandState, boolean> {
    if (s.adopted?.includes(source)) return [s, false]
    const have = new Set(s.labels.map(l => l.caseId))
    const laneStats = { ...s.laneStats }
    for (const [lane, d] of Object.entries(o.laneStats ?? {})) {
      const p = laneStats[lane] ?? { tries: 0, hits: 0, costUsd: 0 }
      laneStats[lane] = { tries: p.tries + d.tries, hits: p.hits + d.hits, costUsd: p.costUsd + d.costUsd }
    }
    return [v(s, {
      slug: s.slug || o.slug,
      officialDomains: [...new Set([...s.officialDomains, ...o.officialDomains])],
      authorizedSellers: [...new Set([...s.authorizedSellers, ...o.authorizedSellers])],
      whitelist: [...new Set([...s.whitelist, ...o.whitelist])],
      labels: [...s.labels, ...o.labels.filter(l => !have.has(l.caseId))],
      thresholds: { ...o.thresholds, ...s.thresholds },
      laneStats,
      hunts: s.hunts + o.hunts,
      kb: s.kb?.builtAt ? s.kb : (o.kb ?? s.kb),
      adopted: [...(s.adopted ?? []), source],
    }), true]
  },
  getThreshold(s: BrandState, deciderId: string): Step<BrandState, number> {
    return [s, s.thresholds[deciderId] ?? DEFAULT_THRESHOLD]
  },
  getLaneStats(s: BrandState): Step<BrandState, Record<string, LaneStat>> {
    return [s, s.laneStats]
  },
  /** Records a build. A failed build still stamps it, so the next hunt can decide when to retry. */
  setKb(s: BrandState, entities: KbEntity[], builtBy: string, now: number): Step<BrandState, number> {
    const kb = s.kb ?? emptyKb()
    const merged = mergeKb(kb, entities)
    return [v(s, { kb: { ...kb, entities: merged, builtBy, builtAt: now } }), merged.length]
  },
  addKbEntity(s: BrandState, e: KbEntity): Step<BrandState, null> {
    const kb = s.kb ?? emptyKb()
    return [v(s, { kb: { ...kb, entities: mergeKb(kb, [e]), removed: kb.removed.filter(id => id !== e.id) } }), null]
  },
  /** A wrong "verified" entry hides real abuse, so a person can always take one back. */
  removeKbEntity(s: BrandState, id: string): Step<BrandState, null> {
    const kb = s.kb ?? emptyKb()
    return [v(s, { kb: { ...kb, entities: kb.entities.filter(e => e.id !== id), removed: [...new Set([...kb.removed, id])] } }), null]
  },
  snapshot(s: BrandState): Step<BrandState, BrandState> {
    return [s, s]
  },
}
