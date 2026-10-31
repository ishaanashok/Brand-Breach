import { laneKey, type Lane } from './types'
import type { LaneStat } from './machines/brand'
import type { SteerKind } from './machines/hunt'

export const STEER_COOLDOWN_MS = 20_000
const EXPLORE = 0.3
const COST_FLOOR = 0.001
// A lane this far in with this little to show is not working, whatever its neighbours do.
const STALL_TRIES = 3
const STALL_RATE = 0.1

export type Steer = { lane: Lane; reason: string; kind: SteerKind }

/** Hits per dollar, normalised across lanes, plus a bonus that shrinks with tries. */
export function laneScores(keys: string[], stats: Record<string, LaneStat>): Record<string, number> {
  const rate = (k: string) => {
    const s = stats[k]
    return s && s.tries ? s.hits / Math.max(s.costUsd, COST_FLOOR) : 0
  }
  const best = Math.max(1e-9, ...keys.map(rate))
  const total = keys.reduce((t, k) => t + (stats[k]?.tries ?? 0), 0)
  return Object.fromEntries(keys.map(k => {
    const tries = stats[k]?.tries ?? 0
    return [k, rate(k) / best + EXPLORE * Math.sqrt(Math.log(total + 2) / (tries + 1))]
  }))
}

export function rankLanes(keys: string[], stats: Record<string, LaneStat>): string[] {
  const s = laneScores(keys, stats)
  return [...keys].sort((a, b) => s[b]! - s[a]!)
}

export function chooseSteer(o: {
  current: Lane; candidates: Lane[]; stats: Record<string, LaneStat>
  lastSteerAt: number; now: number; taken: string[]
  cooldownMs?: number; exhausted?: string[]; blocked?: string[]
  /** Lanes on other surfaces, for when this one has nothing left to try. */
  elsewhere?: Lane[]
}): Steer | null {
  if (o.now - o.lastSteerAt < (o.cooldownMs ?? STEER_COOLDOWN_MS)) return null
  const curKey = laneKey(o.current)
  const done = o.exhausted ?? []
  const usable = (l: Lane) => !done.includes(laneKey(l)) && !o.taken.includes(laneKey(l))
  const free = o.candidates.filter(usable)
  const bestOf = (lanes: Lane[]) => {
    const next = rankLanes(lanes.map(laneKey), o.stats)[0]
    return lanes.find(l => laneKey(l) === next)
  }
  if (done.includes(curKey)) {
    const near = bestOf(free)
    const why = o.blocked?.includes(curKey) ? 'is failing' : 'has no new results'
    if (near) return { lane: near, kind: o.blocked?.includes(curKey) ? 'blocked' : 'exhausted', reason: `${curKey} ${why}; moving to ${laneKey(near)}` }
    const far = bestOf((o.elsewhere ?? []).filter(usable))
    return far ? { lane: far, kind: 'cross-surface', reason: `${curKey} ${why} and ${o.current.source} has nothing left; changing direction to ${laneKey(far)}` } : null
  }
  const cur = o.stats[curKey]
  const others = free.filter(l => laneKey(l) !== curKey)
  if (cur && cur.tries >= STALL_TRIES && cur.hits / cur.tries < STALL_RATE && others.length) {
    const next = bestOf(others)!
    return { lane: next, kind: 'stalled', reason: `${curKey} is not working: ${cur.tries} searches, ${cur.hits.toFixed(1)} useful hits; moving to ${laneKey(next)}` }
  }
  if (!free.some(l => laneKey(l) === curKey)) free.push(o.current)
  const scores = laneScores(free.map(laneKey), o.stats)
  const best = free.reduce((a, b) => (scores[laneKey(b)]! > scores[laneKey(a)]! ? b : a), o.current)
  const bestKey = laneKey(best)
  // Hysteresis, so two near-equal lanes do not flap.
  if (bestKey === curKey || scores[bestKey]! < (scores[curKey] ?? 0) + 0.15) return null
  const rate = (k: string) => {
    const s = o.stats[k]
    return s && s.costUsd > 0 ? (s.hits / s.costUsd).toFixed(0) : 'untried'
  }
  return { lane: best, kind: 'yield', reason: `${curKey} yields ${rate(curKey)} hits per dollar; ${bestKey} yields ${rate(bestKey)}` }
}
