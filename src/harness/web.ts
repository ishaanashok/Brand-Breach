import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
const MAX_BYTES = 1_500_000
const MAX_REDIRECTS = 4

export type SearchItem = { url: string; title: string; snippet: string }
export type Page = { url: string; title: string; text: string }
type Fetch = typeof fetch

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }
const decode = (s: string) => s
  .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (all, e: string) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()]!
    if (!e.startsWith('#')) return all
    const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** DuckDuckGo wraps each link in a redirect through its own site. */
function unwrap(href: string): string | null {
  try {
    const u = new URL(decode(href), 'https://duckduckgo.com')
    const real = u.hostname.endsWith('duckduckgo.com') ? u.searchParams.get('uddg') : u.href
    if (!real || !/^https?:/.test(real)) return null
    return new URL(real).hostname.endsWith('duckduckgo.com') ? null : real
  } catch { return null }
}

export function parseDuckDuckGo(html: string): SearchItem[] {
  const out: SearchItem[] = []
  for (const block of html.split(/class="[^"]*\bresult__body\b/).slice(1)) {
    const link = block.match(/class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ?? block.match(/href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const url = unwrap(link[1]!)
    if (!url) continue // Ads go through a different redirect and don't unwrap.
    const snip = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/)
    out.push({ url, title: stripTags(link[2]!), snippet: snip ? stripTags(snip[1]!) : '' })
  }
  return out
}

export function parseBing(html: string): SearchItem[] {
  const out: SearchItem[] = []
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    let url = decode(link[1]!)
    // Bing's tracking links carry the destination as base64 after "a1".
    try {
      const u = new URL(url)
      const packed = u.hostname.endsWith('bing.com') ? u.searchParams.get('u') : null
      if (packed) url = Buffer.from(packed.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    } catch { continue }
    if (!/^https?:/.test(url)) continue
    const snip = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    out.push({ url, title: stripTags(link[2]!), snippet: snip ? stripTags(snip[1]!) : '' })
  }
  return out
}

/** Bing's scrape often ignores most of a query, so its results must show they are about it. */
export function onTopic(query: string, items: SearchItem[]): SearchItem[] {
  const sites = [...query.matchAll(/\bsite:([^\s"]+)/gi)].map(m => m[1]!.toLowerCase().replace(/^www\./, ''))
  const words = query.toLowerCase().replace(/-?\bsite:\S+/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && w !== 'and' && w !== 'the')
  const need = Math.min(2, words.length)
  return items.filter(i => {
    let host = ''
    try { host = new URL(i.url).hostname.toLowerCase() } catch { return false }
    if (sites.length && !sites.some(x => host === x || host.endsWith(`.${x}`))) return false
    const text = `${i.url} ${i.title} ${i.snippet}`.toLowerCase()
    return words.filter(w => text.includes(w)).length >= need
  })
}

export function parseBrave(body: any): SearchItem[] {
  const results = body?.web?.results
  return (Array.isArray(results) ? results : []).filter((r: any) => typeof r?.url === 'string' && /^https?:/.test(r.url))
    .map((r: any) => ({ url: r.url, title: stripTags(String(r.title ?? '')), snippet: stripTags(String(r.description ?? '')) }))
}

const MIN_GAP_MS = 3000 // Searching faster than this got the machine blocked by DuckDuckGo.
const COOL_DOWN_MS = 5 * 60_000
const CACHE_SIZE = 500
const cache = new Map<string, SearchItem[]>()
let queue: Promise<unknown> = Promise.resolve()
let lastSearch = 0
let primaryRestsUntil = 0

/** Whether search is running on its weak fallback, so a thin hunt can say why. */
export const searchDegraded = () => Date.now() < primaryRestsUntil

/** One attempt at a real web search: an API if there's a key, else DuckDuckGo, else on-topic Bing results. */
export async function searchOnce(query: string, o: { f?: Fetch; braveKey?: string; now?: () => number } = {}): Promise<SearchItem[]> {
  const f = o.f ?? fetch
  const now = o.now ?? Date.now
  const failures: string[] = []
  const headers = { 'user-agent': UA, 'accept-language': 'en-US,en' }
  if (o.braveKey) {
    const res = await f(`https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(query)}`, { headers: { accept: 'application/json', 'x-subscription-token': o.braveKey }, signal: AbortSignal.timeout(12_000) })
    if (!res.ok) throw new Error(`search failed: Brave ${res.status}`)
    return parseBrave(await res.json())
  }
  if (now() >= primaryRestsUntil) {
    try {
      const res = await f(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers, signal: AbortSignal.timeout(12_000) })
      if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`)
      const items = parseDuckDuckGo(await res.text())
      if (items.length) return items.slice(0, 10)
      failures.push('DuckDuckGo returned nothing')
    } catch (err) {
      primaryRestsUntil = now() + COOL_DOWN_MS
      failures.push(String(err))
    }
  }
  try {
    const res = await f(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, { headers, signal: AbortSignal.timeout(12_000) })
    if (!res.ok) throw new Error(`Bing ${res.status}`)
    return onTopic(query, parseBing(await res.text())).slice(0, 10)
  } catch (err) { failures.push(String(err)) }
  throw new Error(`search failed: ${failures.join('; ')}`)
}

/** Every hunt shares one polite queue, and the same search is never sent twice. */
export function webSearch(query: string): Promise<SearchItem[]> {
  const key = query.trim().toLowerCase()
  const known = cache.get(key)
  if (known) return Promise.resolve(known)
  const run = queue.then(async () => {
    const wait = lastSearch + MIN_GAP_MS - Date.now()
    if (wait > 0) await Bun.sleep(wait)
    lastSearch = Date.now()
    const items = await searchOnce(query, { braveKey: process.env.BRAVE_SEARCH_API_KEY })
    if (cache.size >= CACHE_SIZE) cache.clear()
    if (items.length) cache.set(key, items)
    return items
  })
  queue = run.catch(() => {})
  return run
}

const privateV4 = (ip: string) => {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
export function isPrivateAddress(ip: string) {
  if (isIP(ip) === 4) return privateV4(ip)
  const v6 = ip.toLowerCase()
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return privateV4(mapped[1]!)
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

/** Links on scam pages and model output both choose these URLs, so neither may reach this machine or its network. */
async function assertPublic(url: URL, resolve: typeof lookup) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`refused ${url.protocol}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('refused private host')
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host, { all: true })
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error('refused private address')
}

export function htmlToPage(url: string, html: string): Page {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const text = stripTags(html
    .replace(/<(script|style|noscript|svg|template|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' '))
  return { url, title, text }
}

/** Reads a page as text. No scripts run and nothing on the page is loaded or submitted. */
export async function readPage(raw: string, o: { fetch?: Fetch; resolve?: typeof lookup } = {}): Promise<Page> {
  const f = o.fetch ?? fetch
  const resolve = o.resolve ?? lookup
  let url = new URL(raw)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url, resolve)
    const res = await f(url, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,text/plain' }, signal: AbortSignal.timeout(10_000) })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    if (type && !/text\/|html|xml/.test(type)) throw new Error(`not a page: ${type}`)
    const reader = res.body?.getReader()
    let size = 0
    let html = ''
    const dec = new TextDecoder()
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      html += dec.decode(value, { stream: true })
      if (size > MAX_BYTES) { await reader.cancel(); break }
    }
    return htmlToPage(url.href, html)
  }
  throw new Error('too many redirects')
}
