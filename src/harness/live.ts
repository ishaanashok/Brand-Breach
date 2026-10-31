import type { Hit, Lane, Lead, Surface } from '../core/types'
import type { SearchResult, Source } from './source'

const STRATEGIES: Record<Surface, Record<string, string>> = {
  marketplace: { 'discount-parts': 'discount replica parts for sale', 'accessories': 'cheap unofficial merchandise listing' },
  social: { 'giveaway-posts': 'crypto giveaway promotion post', 'promo-accounts': 'fake official promotion account' },
  channels: { 'telegram-groups': 'public telegram group giveaway', 'discord-invites': 'public discord server promotion' },
  domains: { 'lookalike-sites': 'lookalike giveaway website', 'crypto-landing': 'double your crypto landing page' },
  video: { 'deepfake-streams': 'AI deepfake livestream giveaway', 'promo-clips': 'fake promotion video' },
}

// Estimated, because the search tool's fee is not published in the PRD's sources.
const EST_SEARCH_USD = 0.01

/**
 * Searches through OpenAI's web search on Luna. It only reads titles and snippets
 * from search results and never fetches a page, which keeps scam content out of this process.
 * Written against stubs: no API key was available when it was built.
 */
export function liveSource({ apiKey, baseUrl = 'https://api.openai.com', fetch: f = fetch }: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): Source {
  const run = async (surface: Surface, query: string): Promise<SearchResult> => {
    const res = await f(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-6-luna', tools: [{ type: 'web_search' }], input: `List public web results for: ${query}` }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`search ${res.status}`)
    const body: any = await res.json()
    const hits: Hit[] = []
    for (const item of body.output ?? []) {
      for (const part of item.content ?? []) {
        for (const a of part.annotations ?? []) {
          if (a.type === 'url_citation' && a.url) hits.push({ url: a.url, surface, title: a.title ?? a.url, snippet: (part.text ?? '').slice(a.start_index ?? 0, a.end_index ?? 300) })
        }
      }
    }
    return { hits, usd: EST_SEARCH_USD }
  }
  return {
    id: 'live',
    estUsd: EST_SEARCH_USD,
    search: (lane: Lane) => run(lane.source, `${lane.query} ${STRATEGIES[lane.source]?.[lane.strategy] ?? lane.strategy}`),
    followLead: (lead: Lead, lane: Lane) => run(lane.source, `"${lead.value}" ${lane.query}`),
    lanes: (surface, keywords) => Object.keys(STRATEGIES[surface]).map(strategy => ({ source: surface, strategy, query: keywords.join(' ') })),
  }
}
