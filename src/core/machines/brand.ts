import type { Step } from '../types.js'

export type LaneStat = { tries: number; hits: number; costUsd: number }
export type Edge = { from: string; to: string; kind: string }
export type Label = { caseId: string; url: string; decision: 'approve' | 'reject'; deciderId: string; score: number; seller?: string }

export type BrandState = {
  version: number
  slug: string
  officialDomains: string[]
  authorizedSellers: string[]
  whitelist: string[]
  labels: Label[]
  seen: Record<string, { score: number; state: string }>
  edges: Edge[]
  laneStats: Record<string, LaneStat>
  thresholds: Record<string, number>
  hunts: number
}

export const DEFAULT_THRESHOLD = 0.5
const STEP = 0.02

export const initialBrand = (): BrandState => ({
  version: 0, slug: '', officialDomains: [], authorizedSellers: [], whitelist: [], labels: [],
  seen: {}, edges: [], laneStats: {}, thresholds: {}, hunts: 0,
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
  markSeen(s: BrandState, url: string, r: { score: number; state: string }): Step<BrandState, null> {
    return [v(s, { seen: { ...s.seen, [url]: r } }), null]
  },
  getSeen(s: BrandState, url: string): Step<BrandState, { score: number; state: string } | null> {
    return [s, s.seen[url] ?? null]
  },
  getThreshold(s: BrandState, deciderId: string): Step<BrandState, number> {
    return [s, s.thresholds[deciderId] ?? DEFAULT_THRESHOLD]
  },
  getLaneStats(s: BrandState): Step<BrandState, Record<string, LaneStat>> {
    return [s, s.laneStats]
  },
  snapshot(s: BrandState): Step<BrandState, BrandState> {
    return [s, s]
  },
}
