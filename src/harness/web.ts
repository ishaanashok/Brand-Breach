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

/** A real web search. Falls through to the second engine when the first blocks or returns nothing. */
export async function webSearch(query: string, f: Fetch = fetch): Promise<SearchItem[]> {
  const engines: [string, (h: string) => SearchItem[]][] = [
    [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parseDuckDuckGo],
    [`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, parseBing],
  ]
  const failures: string[] = []
  for (const [url, parse] of engines) {
    try {
      const res = await f(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en' }, signal: AbortSignal.timeout(12_000) })
      if (!res.ok) { failures.push(`${new URL(url).hostname} ${res.status}`); continue }
      const items = parse(await res.text())
      if (items.length) return items.slice(0, 10)
      failures.push(`${new URL(url).hostname} returned nothing`)
    } catch (err) { failures.push(String(err)) }
  }
  throw new Error(`search failed: ${failures.join('; ')}`)
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
