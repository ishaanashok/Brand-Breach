import { SURFACES, type Step } from '../types.js'
import type { LaneStat } from './brand.js'
import { SEED_COMMENTARY, normalizeCommentary } from '../commentary.js'

export type PlaybookState = { version: number; priors: Record<string, LaneStat>; hunts: string[]; commentary?: string[]; adopted?: string[] }

export const initialPlaybook = (): PlaybookState => ({ version: 0, priors: {}, hunts: [], commentary: SEED_COMMENTARY })

const v = (s: PlaybookState, patch: Partial<PlaybookState>): PlaybookState => ({ ...s, ...patch, version: s.version + 1 })

/** Only `surface/strategy` keys pass, so brand query text can never land in global priors. */
const isAnonymousKey = (k: string) => {
  const [source, strategy, extra] = k.split('/')
  return extra === undefined && SURFACES.includes(source as any) && !!strategy && /^[a-z0-9-]+$/.test(strategy)
}

// A playbook saved before this list existed still has to start from the seed.
const commentaryOf = (s: PlaybookState) => s.commentary ?? SEED_COMMENTARY

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
  getCommentary(s: PlaybookState): Step<PlaybookState, string[]> {
    return [s, commentaryOf(s)]
  },
  /** False if the entry would cover a whole shared platform. */
  addCommentary(s: PlaybookState, raw: string): Step<PlaybookState, boolean> {
    const entry = normalizeCommentary(raw)
    if (!entry) return [s, false]
    const list = commentaryOf(s)
    return list.includes(entry) ? [s, true] : [v(s, { commentary: [...list, entry] }), true]
  },
  removeCommentary(s: PlaybookState, entry: string): Step<PlaybookState, null> {
    return [v(s, { commentary: commentaryOf(s).filter(e => e !== entry) }), null]
  },
  snapshot(s: PlaybookState): Step<PlaybookState, PlaybookState> {
    return [s, s]
  },
}
