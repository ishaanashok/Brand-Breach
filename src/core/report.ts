import type { CaseState } from './machines/case'
import type { HuntState } from './machines/hunt'

export function buildReport(h: HuntState, cases: CaseState[]) {
  const bySurface: Record<string, { candidates: number; verified: number; usd: number }> = {}
  const deciders: Record<string, { calls: number; latencies: number[] }> = {}
  const addDecider = (r: { deciderId: string; latencyMs: number } | null) => {
    if (!r) return
    const d = (deciders[r.deciderId] ??= { calls: 0, latencies: [] })
    d.calls++
    d.latencies.push(r.latencyMs)
  }
  for (const c of cases) {
    const s = (bySurface[c.hit?.surface ?? 'unknown'] ??= { candidates: 0, verified: 0, usd: 0 })
    s.candidates++
    if (c.verification?.verified) s.verified++
    s.usd += (c.triage?.usd ?? 0) + (c.verification?.usd ?? 0)
    addDecider(c.triage)
    addDecider(c.verification)
  }
  const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0
  return {
    disclaimer: 'Candidates flagged for review, not findings of wrongdoing. No notice was submitted.',
    totals: {
      ...h.counters,
      spentUsd: h.spent,
      budgetUsd: h.input?.budgetUsd ?? 0,
      costPerVerified: h.counters.verified ? h.spent / h.counters.verified : 0,
      firstVerifiedSpendUsd: h.firstVerifiedSpend,
      secondsToFirstVerified: h.firstVerifiedAt ? (h.firstVerifiedAt - h.startedAt) / 1000 : null,
    },
    bySurface,
    deciders: Object.fromEntries(Object.entries(deciders).map(([id, d]) => [id, { calls: d.calls, medianMs: q(d.latencies, 0.5), p95Ms: q(d.latencies, 0.95) }])),
    perCase: cases.map(c => ({
      id: c.id, url: c.hit?.url, surface: c.hit?.surface, state: c.state, score: c.verification?.score ?? c.triage?.score ?? null,
      decider: c.verification?.deciderId ?? c.triage?.deciderId ?? null, why: c.skipReason ?? c.verification?.why ?? c.triage?.why,
    })),
  }
}
