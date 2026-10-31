import { pickEscalations, type Escalation } from '../core/escalate'
import { chooseSteer } from '../core/lanes'
import { DEFAULT_THRESHOLD } from '../core/machines/brand'
import type { CaseState } from '../core/machines/case'
import { thresholdFor } from '../core/policy'
import { encodeTag } from '../core/tags'
import { SURFACES, laneKey, type HuntInput, type Lane, type Surface } from '../core/types'
import type { Participant } from '../relay/types'
import type { Store } from '../store/types'

export type OrchestratorDeps = {
  huntId: string; input: HuntInput; brandSlug: string; store: Store; me: Participant
  lanes: (s: Surface) => Lane[]; cooldownMs: number
  /** Starts a reasoning agent on a case; false means the budget would not cover it. */
  spawnReasoner?: (c: CaseState, e: Escalation) => Promise<boolean>
  slots?: () => number
}

const MAX_REASONERS_PER_HUNT = 8

/** Holds nothing durable: every tick reads roster and stats from the actors. */
export function createOrchestrator(d: OrchestratorDeps) {
  const lastSent = new Map<string, number>()
  const exhausted = new Set<string>()
  const blocked = new Set<string>()
  let outOfBudget = false

  async function tick(now = Date.now()) {
    const h = await d.store.hunt(d.huntId).snapshot()
    if (h.status !== 'running') return
    const stats = await d.store.brand(d.brandSlug).getLaneStats()
    for (const s of Object.values(h.roster)) {
      if (s.status.startsWith('exhausted:')) exhausted.add(s.status.slice('exhausted:'.length))
      if (s.status.startsWith('blocked:')) {
        exhausted.add(s.status.slice('blocked:'.length))
        blocked.add(s.status.slice('blocked:'.length))
      }
    }
    const entries = Object.entries(h.roster)
    for (const [name, entry] of entries) {
      const taken = entries.filter(([n]) => n !== name).map(([, e]) => laneKey(e.lane))
      const steer = chooseSteer({
        current: entry.lane,
        candidates: d.lanes(name as Surface),
        stats,
        lastSteerAt: Math.max(entry.laneChangedAt, lastSent.get(name) ?? 0),
        now,
        taken,
        cooldownMs: d.cooldownMs,
        exhausted: [...exhausted],
        blocked: [...blocked],
        elsewhere: SURFACES.filter(x => x !== name).flatMap(x => d.lanes(x)),
      })
      if (!steer) continue
      lastSent.set(name, now)
      await d.me.send(`@${name}`, encodeTag('STEER', steer))
    }
  }

  /** Cases that quick decisions could not settle and a reasoner should still look at. */
  async function escalations(now = Date.now()): Promise<Escalation[]> {
    if (!d.spawnReasoner || outOfBudget) return []
    const h = await d.store.hunt(d.huntId).snapshot()
    const room = MAX_REASONERS_PER_HUNT - (h.spawns?.length ?? 0)
    if (room <= 0) return []
    const [cases, { thresholds }] = await Promise.all([
      d.store.cases(h.caseIds),
      d.store.brand(d.brandSlug).snapshot(),
    ])
    const threshold = (c: CaseState) => thresholdFor(thresholds[c.triage?.deciderId ?? ''] ?? DEFAULT_THRESHOLD, d.input.precision)
    return pickEscalations(cases, { slots: Math.min(room, d.slots?.() ?? room), now, threshold })
  }

  async function escalate() {
    if ((await d.store.hunt(d.huntId).snapshot()).status !== 'running') return
    for (const e of await escalations()) {
      const c = await d.store.kase(e.caseId).snapshot()
      if (!(await d.spawnReasoner!(c, e))) { outOfBudget = true; return }
    }
  }

  /** Every lane the roster could still move to has run out. */
  async function finished(): Promise<boolean> {
    const h = await d.store.hunt(d.huntId).snapshot()
    const names = Object.keys(h.roster)
    if (names.length < SURFACES.length) return false
    const allIdle = names.every(n => /^(exhausted|blocked):/.test(h.roster[n]!.status))
    if (!allIdle) return false
    const left = names.some(n => d.lanes(n as Surface).some(l => !exhausted.has(laneKey(l))))
    return !left
  }

  return { tick, finished, escalate, escalations }
}
