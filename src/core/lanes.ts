import { laneKey, type Lane } from './types'
import type { LaneStat } from './machines/brand'

export const STEER_COOLDOWN_MS = 20_000
const EXPLORE = 0.3
const COST_FLOOR = 0.001

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
  cooldownMs?: number; exhausted?: string[]
}): { lane: Lane; reason: string } | null {
  if (o.now - o.lastSteerAt < (o.cooldownMs ?? STEER_COOLDOWN_MS)) return null
  const curKey = laneKey(o.current)
  const done = o.exhausted ?? []
  const free = o.candidates.filter(l => !done.includes(laneKey(l)) && !o.taken.includes(laneKey(l)))
  if (done.includes(curKey)) {
    const next = rankLanes(free.map(laneKey), o.stats)[0]
    const lane = free.find(l => laneKey(l) === next)
    return lane ? { lane, reason: `${curKey} has no results left; moving to ${next}` } : null
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
  return { lane: best, reason: `${curKey} yields ${rate(curKey)} hits per dollar; ${bestKey} yields ${rate(bestKey)}` }
}
