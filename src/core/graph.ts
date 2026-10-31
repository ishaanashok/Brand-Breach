import { kbEntities, matchKb, resembles } from './kb'
import type { BrandState } from './machines/brand'
import type { CaseState } from './machines/case'
import type { HuntState } from './machines/hunt'

export type Trust = 'brand' | 'verified' | 'candidate' | 'infringing' | 'suspect' | 'cleared' | 'unknown' | 'agent'
export type GraphLayer = 'knowledge' | 'findings' | 'orchestration'
export type GraphNode = {
  id: string; kind: string; label: string; trust: Trust; layer: GraphLayer
  caseId?: string; detail?: string; source?: string; confidence?: number
}
export type GraphEdge = { from: string; to: string; kind: string; layer: GraphLayer; reason?: string }
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

const INFRINGING = new Set(['verified', 'awaiting_approval', 'approved'])
const CLEARED = new Set(['cleared', 'rejected'])


/**
 * One brand's world as a graph: what is known to be real, what the hunt found,
 * and how the orchestrator moved through it. Pure, so the API and tests read the same thing.
 */
export function buildGraph(brand: BrandState, cases: CaseState[], hunt?: HuntState): Graph {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const put = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id }
  const link = (e: GraphEdge) => { edges.set(`${e.from}|${e.to}|${e.kind}`, e) }

  const root = put({ id: `brand:${brand.slug}`, kind: 'brand', label: hunt?.input?.brand ?? brand.slug, trust: 'brand', layer: 'knowledge' })
  const known = kbEntities(brand)
  for (const e of known) {
    put({ id: e.id, kind: e.kind, label: e.value, trust: e.status, layer: 'knowledge', source: e.source, confidence: e.confidence, detail: e.evidence })
    link({ from: root, to: e.id, kind: e.status === 'verified' ? 'owns' : 'may_own', layer: 'knowledge' })
  }

  for (const c of cases) {
    if (!c.hit) continue
    const id = `listing:${c.hit.url}`
    const home = matchKb(c.hit, known)
    const trust: Trust = home ? 'verified' : INFRINGING.has(c.state) ? 'infringing' : CLEARED.has(c.state) || c.state === 'skipped' ? 'cleared' : 'suspect'
    put({ id, kind: 'listing', label: c.hit.title, trust, layer: 'findings', caseId: c.id, detail: c.hit.url })
    if (home) link({ from: id, to: home.id, kind: 'belongs_to', layer: 'knowledge' })
    else {
      const like = resembles(c.hit.url, known)
      if (like) link({ from: id, to: like.id, kind: 'resembles', layer: 'findings' })
    }
    if (c.hit.lane) {
      const lane = `lane:${c.hit.lane}`
      put({ id: lane, kind: 'lane', label: c.hit.lane, trust: 'agent', layer: 'orchestration' })
      link({ from: lane, to: id, kind: 'found', layer: 'orchestration' })
    }
  }

  // Entities reached through leads take on the standing of what they are linked to.
  for (const e of brand.edges) {
    // Lead values keep their case so redaction can find them; KB ids are lowercase.
    const canon = (raw: string) => (nodes.has(raw.toLowerCase()) && !raw.startsWith('listing:') ? raw.toLowerCase() : raw)
    const [from, to] = [canon(e.from), canon(e.to)]
    for (const n of [from, to]) {
      if (nodes.has(n)) continue
      const at = n.indexOf(':')
      put({ id: n, kind: n.slice(0, at), label: n.slice(at + 1), trust: 'unknown', layer: 'findings' })
    }
    link({ from, to, kind: e.kind, layer: 'findings' })
  }
  for (const e of edges.values()) {
    if (e.layer !== 'findings') continue
    const [a, b] = [nodes.get(e.from), nodes.get(e.to)]
    if (a?.trust === 'infringing' && b?.trust === 'unknown') b.trust = 'suspect'
  }

  if (hunt) {
    const orch = put({ id: 'agent:orchestrator', kind: 'orchestrator', label: 'Orchestrator', trust: 'agent', layer: 'orchestration' })
    for (const [name, s] of Object.entries(hunt.roster)) {
      const scout = put({ id: `agent:${name}`, kind: 'scout', label: name, trust: 'agent', layer: 'orchestration', detail: s.status })
      link({ from: orch, to: scout, kind: 'directs', layer: 'orchestration' })
      const key = `${s.lane.source}/${s.lane.strategy}`
      put({ id: `lane:${key}`, kind: 'lane', label: key, trust: 'agent', layer: 'orchestration' })
      link({ from: scout, to: `lane:${key}`, kind: 'searching', layer: 'orchestration' })
    }
    for (const s of hunt.steers) {
      for (const k of [s.from, s.to]) put({ id: `lane:${k}`, kind: 'lane', label: k, trust: 'agent', layer: 'orchestration' })
      link({ from: `lane:${s.from}`, to: `lane:${s.to}`, kind: 'steered', layer: 'orchestration', reason: s.reason })
    }
    for (const sp of hunt.spawns ?? []) {
      const agent = put({ id: `reasoner:${sp.caseId}`, kind: 'reasoner', label: sp.agent, trust: 'agent', layer: 'orchestration', detail: sp.outcome ?? 'running' })
      link({ from: orch, to: agent, kind: 'spawned', layer: 'orchestration', reason: sp.trigger })
      const c = cases.find(x => x.id === sp.caseId)
      if (c?.hit) link({ from: agent, to: `listing:${c.hit.url}`, kind: 'assessed', layer: 'orchestration', reason: sp.outcome })
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to)) }
}
