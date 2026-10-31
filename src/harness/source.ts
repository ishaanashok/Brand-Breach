import type { QueryOutcome, SearchHistory } from '../core/machines/brand'
import type { Hit, Lane, Lead } from '../core/types'

export type SearchResult = {
  hits: Hit[]; usd: number
  /** Links found on pages that were already sent on by OnHits. */
  leads?: { lead: Lead; from: string }[]
  /** Each query this search ran and how it went, for later hunts. */
  queries?: QueryOutcome[]
}
export type Capture = { text?: string; problem?: string }
/** Takes hits as soon as they're found, and says how many new ones look worth a closer look. */
export type OnHits = (hits: Hit[]) => Promise<number>

/** Live and recorded sources share this type, so the pipeline cannot tell them apart. */
export interface Source {
  id: string
  /** Upper bound reserved before each search. */
  estUsd: number
  search(lane: Lane, onHits?: OnHits): Promise<SearchResult>
  followLead(lead: Lead, lane: Lane, onHits?: OnHits): Promise<SearchResult>
  /** Every lane a scout on this surface may be steered to. */
  lanes(surface: Lane['source'], keywords: string[]): Lane[]
  /** Hands back what was already covered, after a restart or by an earlier hunt for this brand. */
  restore?(known: { searches: number; urls: string[]; history?: SearchHistory }): void
  /** Why this source has nothing left to do, or null while it still has. */
  over?(): string | null
  /** Page text for a shortlisted hit, which until then is only a search result. Without text, it says why. */
  capture?(url: string): Promise<Capture>
  /** Anything that limited this hunt's results, for its last line. */
  caveat?(): string | null
  /** An agent is out, or only just came back and may have left a lead for another to follow. */
  busy?(): boolean
  /** Paused time doesn't count as having nothing to do. */
  touch?(): void
}

/** Switches to the backup if the primary returns too few candidates in the window. */
export function autoFallback(primary: Source, backup: Source, o: {
  minHits: number; withinMs: number; now?: () => number; onSwitch?: (reason: string) => void
}): Source & { active(): string } {
  const now = o.now ?? Date.now
  const started = now()
  let hits = 0
  let switched = false
  const pick = () => {
    if (!switched && hits < o.minHits && now() - started >= o.withinMs) {
      switched = true
      o.onSwitch?.(`${primary.id} returned ${hits} candidates in ${o.withinMs / 1000}s`)
    }
    return switched ? backup : primary
  }
  const track = async (run: (s: Source) => Promise<SearchResult>): Promise<SearchResult> => {
    const s = pick()
    try {
      const r = await run(s)
      if (s === primary) hits += r.hits.length
      return r
    } catch (err) {
      if (s === backup) throw err
      return { hits: [], usd: 0 }
    }
  }
  return {
    id: `auto(${primary.id}>${backup.id})`,
    estUsd: Math.max(primary.estUsd, backup.estUsd),
    search: lane => track(s => s.search(lane)),
    followLead: (lead, lane) => track(s => s.followLead(lead, lane)),
    lanes: (surface, kw) => primary.lanes(surface, kw),
    active: () => (switched ? backup.id : primary.id),
  }
}
