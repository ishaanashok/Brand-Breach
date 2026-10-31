import type { SearchItem } from './web'

export const LUNA_MODEL = 'gpt-6-luna'
// Reported by resellers, not by OpenAI's own rate card, so all three can be overridden by env.
export const LUNA_USD_PER_M_INPUT = 0.1
export const LUNA_USD_PER_M_OUTPUT = 0.5
export const LUNA_SEARCH_USD = 0.012 // About $0.01 for the search, plus the tokens that read it.

const MAX_RESULTS = 60 // A real search returned 40 to 55 sources, and only the citations have titles.
const RETRIES = 3

/** OpenAI tags cited links, so the same page would otherwise look new when it appears untagged. */
function untagged(raw: string): string {
  const u = new URL(raw)
  if (u.searchParams.get('utm_source') === 'openai') u.searchParams.delete('utm_source')
  return u.href
}

/** Citations carry a title and a passage, and the source list adds pages the answer didn't cite. */
export function parseLunaSearch(body: any): SearchItem[] {
  const found = new Map<string, SearchItem>()
  const output = body?.output ?? []
  for (const item of output) {
    for (const part of item.content ?? []) {
      for (const a of part.annotations ?? []) {
        if (a.type !== 'url_citation' || typeof a.url !== 'string' || !/^https?:/.test(a.url)) continue
        const url = untagged(a.url)
        const text = String(part.text ?? '')
        const snippet = text.slice(Math.max(0, (a.start_index ?? 0) - 300), a.start_index ?? 300).split('\n').at(-1)!.trim()
        if (!found.has(url)) found.set(url, { url, title: String(a.title ?? url), snippet })
      }
    }
  }
  // The search call comes before the answer, but a citation says more about the same page.
  for (const item of output) {
    for (const s of item.action?.sources ?? []) {
      if (typeof s?.url !== 'string' || !/^https?:/.test(s.url)) continue
      const url = untagged(s.url)
      if (!found.has(url)) found.set(url, { url, title: String(s.title ?? url), snippet: '' })
    }
  }
  return [...found.values()].slice(0, MAX_RESULTS)
}

/** Web search through OpenAI, standing in for scraping a search engine. */
export function lunaSearch(o: { apiKey: string; baseUrl?: string; model?: string; fetch?: typeof fetch }) {
  const f = o.fetch ?? fetch
  const base = o.baseUrl ?? 'https://api.openai.com'
  return async (query: string): Promise<SearchItem[]> => {
    let last = ''
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (attempt) await Bun.sleep(1000 * 2 ** attempt)
      const res = await f(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({
          model: o.model ?? LUNA_MODEL,
          tools: [{ type: 'web_search' }],
          tool_choice: 'required',
          include: ['web_search_call.action.sources'],
          reasoning: { effort: 'low' },
          input: `Search the public web for this exact query and cite every relevant page, including unofficial ones. Don't judge them. Query: ${query}`,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (res.status === 429 || res.status >= 500) { last = `OpenAI search ${res.status}`; continue }
      if (!res.ok) throw new Error(`OpenAI search ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return parseLunaSearch(await res.json())
    }
    throw new Error(last)
  }
}
