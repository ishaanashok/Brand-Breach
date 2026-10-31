import { SURFACES, type Step } from '../types'
import type { LaneStat } from './brand'

export type PlaybookState = { version: number; priors: Record<string, LaneStat>; hunts: string[] }

export const initialPlaybook = (): PlaybookState => ({ version: 0, priors: {}, hunts: [] })

const v = (s: PlaybookState, patch: Partial<PlaybookState>): PlaybookState => ({ ...s, ...patch, version: s.version + 1 })

/** Only `surface/strategy` keys pass, so brand query text can never land in global priors. */
const isAnonymousKey = (k: string) => {
  const [source, strategy, extra] = k.split('/')
  return extra === undefined && SURFACES.includes(source as any) && !!strategy && /^[a-z0-9-]+$/.test(strategy)
}

export const playbook = {
  update(s: PlaybookState, lane: string, d: LaneStat): Step<PlaybookState, null> {
    if (!isAnonymousKey(lane)) return [s, null]
    const p = s.priors[lane] ?? { tries: 0, hits: 0, costUsd: 0 }
    return [v(s, { priors: { ...s.priors, [lane]: { tries: p.tries + d.tries, hits: p.hits + d.hits, costUsd: p.costUsd + d.costUsd } } }), null]
  },
  getPriors(s: PlaybookState): Step<PlaybookState, Record<string, LaneStat>> {
    return [s, s.priors]
  },
  registerHunt(s: PlaybookState, id: string): Step<PlaybookState, null> {
    return s.hunts.includes(id) ? [s, null] : [v(s, { hunts: [...s.hunts, id] }), null]
  },
  listHunts(s: PlaybookState): Step<PlaybookState, string[]> {
    return [s, s.hunts]
  },
  snapshot(s: PlaybookState): Step<PlaybookState, PlaybookState> {
    return [s, s]
  },
}
