import { SURFACES, type Step } from '../types.js'
import type { LaneStat } from './brand.js'

export type PlaybookState = { version: number; priors: Record<string, LaneStat>; hunts: string[]; adopted?: string[] }

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
  /** Folds in an older store's history, once. */
  adopt(s: PlaybookState, source: string, o: PlaybookState): Step<PlaybookState, boolean> {
    if (s.adopted?.includes(source)) return [s, false]
    const priors = { ...s.priors }
    for (const [lane, d] of Object.entries(o.priors)) {
      const p = priors[lane] ?? { tries: 0, hits: 0, costUsd: 0 }
      priors[lane] = { tries: p.tries + d.tries, hits: p.hits + d.hits, costUsd: p.costUsd + d.costUsd }
    }
    return [v(s, { priors, hunts: [...new Set([...s.hunts, ...o.hunts])], adopted: [...(s.adopted ?? []), source] }), true]
  },
  snapshot(s: PlaybookState): Step<PlaybookState, PlaybookState> {
    return [s, s]
  },
}
