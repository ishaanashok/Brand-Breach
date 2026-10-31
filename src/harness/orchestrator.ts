import { chooseSteer } from '../core/lanes'
import { encodeTag } from '../core/tags'
import { SURFACES, laneKey, type HuntInput, type Lane, type Surface } from '../core/types'
import type { Participant } from '../relay/types'
import type { Store } from '../store/types'

export type OrchestratorDeps = {
  huntId: string; input: HuntInput; brandSlug: string; store: Store; me: Participant
  lanes: (s: Surface) => Lane[]; cooldownMs: number
}

/** Holds nothing durable: every tick reads roster and stats from the actors. */
export function createOrchestrator(d: OrchestratorDeps) {
  const lastSent = new Map<string, number>()
  const exhausted = new Set<string>()

  async function tick(now = Date.now()) {
    const h = await d.store.hunt(d.huntId).snapshot()
    if (h.status !== 'running') return
    const stats = await d.store.brand(d.brandSlug).getLaneStats()
    for (const s of Object.values(h.roster)) {
      if (s.status.startsWith('exhausted:')) exhausted.add(s.status.slice('exhausted:'.length))
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
      })
      if (!steer) continue
      lastSent.set(name, now)
      await d.me.send(`@${name}`, encodeTag('STEER', steer))
    }
  }

  /** Every lane the roster could still move to has run out. */
  async function finished(): Promise<boolean> {
    const h = await d.store.hunt(d.huntId).snapshot()
    const names = Object.keys(h.roster)
    if (names.length < SURFACES.length) return false
    const allIdle = names.every(n => h.roster[n]!.status.startsWith('exhausted:'))
    if (!allIdle) return false
    const left = names.some(n => d.lanes(n as Surface).some(l => !exhausted.has(laneKey(l))))
    return !left
  }

  return { tick, finished }
}
