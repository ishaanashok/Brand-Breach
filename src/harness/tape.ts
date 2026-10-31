import { laneKey, type Hit, type Lane, type Lead, type Surface } from '../core/types'
import type { SearchResult, Source } from './source'

export type TapeFile = {
  note: string
  searchUsd: number
  lanes: { source: Surface; strategy: string; pages: Hit[][] }[]
  leadResults: Record<string, Hit[]>
}

/**
 * Replays a recorded hunt. `run` varies campaign URLs so a repeat hunt sees
 * some fresh listings alongside ones the brand already remembers.
 */
export function tapeSource(tape: TapeFile, { run = 1, delayMs = 0 }: { run?: number; delayMs?: number } = {}): Source {
  const cursor = new Map<string, number>()
  const leadsServed = new Set<string>()
  const fresh = (h: Hit): Hit => ({ ...h, url: h.url.replace('{run}', String(run)) })
  const wait = () => (delayMs ? new Promise(r => setTimeout(r, delayMs)) : Promise.resolve())

  return {
    id: 'tape',
    estUsd: tape.searchUsd,
    async search(lane: Lane): Promise<SearchResult> {
      await wait()
      const key = laneKey(lane)
      const pages = tape.lanes.find(l => laneKey(l) === key)?.pages ?? []
      const i = cursor.get(key) ?? 0
      cursor.set(key, i + 1)
      return { hits: (pages[i] ?? []).map(fresh), usd: tape.searchUsd }
    },
    async followLead(lead: Lead): Promise<SearchResult> {
      await wait()
      const key = `${lead.kind}:${lead.value}`
      if (leadsServed.has(key)) return { hits: [], usd: 0 }
      leadsServed.add(key)
      return { hits: (tape.leadResults[key] ?? []).map(fresh), usd: tape.searchUsd }
    },
    lanes(surface, keywords) {
      return tape.lanes.filter(l => l.source === surface).map(l => ({ source: surface, strategy: l.strategy, query: keywords.join(' ') }))
    },
  }
}

export const loadTape = async (path = new URL('../../tapes/tesla.json', import.meta.url).pathname) =>
  (await Bun.file(path).json()) as TapeFile
