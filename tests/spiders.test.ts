import { expect, test } from 'bun:test'
import { SPIDER_MODEL, nimClient, runSpider, spiderSource, webMemory, type ChatMessage } from '../src/harness/spiders'
import { sharedSlots } from '../src/deciders/util'
import { verifyTick } from '../src/harness/verifier'
import { MemoryStore } from '../src/store/memory'
import { glmKbReasoner } from '../src/reasoners/glm'
import { htmlToPage, isPrivateAddress, onTopic, parseBing, parseBrave, parseDuckDuckGo, readPage, searchDegraded, searchOnce } from '../src/harness/web'

const call = (name: string, args: unknown) => ({ id: name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })
const scripted = (turns: ChatMessage[]) => {
  const sent: ChatMessage[][] = []
  return { sent, model: 'glm', chat: async (m: ChatMessage[]) => { sent.push([...m]); return { message: turns.shift() ?? { role: 'assistant', content: 'done' }, usd: 0.001 } } }
}
const base = { brand: 'Acme', officialDomains: ['acme.com'], surface: 'domains' as const, mission: 'fake stores' }
const search = async () => [{ url: 'https://acme-outlet.shop/deals', title: 'Acme Outlet', snippet: '90% off' }]

test('a reported URL must have really come back from the web', async () => {
  const nim = scripted([
    { role: 'assistant', content: null, tool_calls: [call('web_search', { query: 'acme outlet' })] },
    { role: 'assistant', content: null, tool_calls: [call('report', { candidates: [{ url: 'https://acme-outlet.shop/deals' }, { url: 'https://made-up.example/x' }] })] },
  ])
  const r = await runSpider({ ...base, nim, search, read: async url => ({ url, title: 't', text: 'page words' }) })
  expect(r.hits.map(h => h.url)).toEqual(['https://acme-outlet.shop/deals'])
  expect(r.hits[0]!.evidenceText).toBe('page words')
  expect(r.searches).toBe(1)
  expect(r.usd).toBeCloseTo(0.002)
})

test('a spider that never reports finds nothing, and a failing tool does not stop it', async () => {
  const nim = scripted([{ role: 'assistant', content: null, tool_calls: [call('read_page', { url: 'http://bad' })] }])
  const r = await runSpider({ ...base, nim, search, read: async () => { throw new Error('nope') } })
  expect(r.hits).toEqual([])
  expect(nim.sent[1]!.at(-1)!.content).toContain('failed')
})

test('a lane runs once, then reports nothing so the hunt can end', async () => {
  const nim = scripted([{ role: 'assistant', content: 'nothing' }, { role: 'assistant', content: 'nothing' }])
  const s = spiderSource({ brand: 'Acme', officialDomains: [], nim })
  const lane = s.lanes('domains', ['acme'])[0]!
  await s.search(lane)
  await s.search(lane)
  expect(nim.sent.length).toBe(1)
})

test('agents sharing a hunt get refused repeats and only see new results', async () => {
  const memory = webMemory()
  const items = async () => [{ url: 'https://www.acme-outlet.shop/deals', title: 'A', snippet: '' }, { url: 'https://other.shop/', title: 'B', snippet: '' }]
  const first = scripted([{ role: 'assistant', content: null, tool_calls: [call('web_search', { query: 'Acme outlet deals' })] }, { role: 'assistant', content: null, tool_calls: [call('report', { candidates: [{ url: 'https://acme-outlet.shop/deals' }] })] }])
  expect((await runSpider({ ...base, nim: first, memory, search: items, read: async url => ({ url, title: 't', text: 'x' }) })).hits.length).toBe(1)

  const second = scripted([
    { role: 'assistant', content: null, tool_calls: [call('web_search', { query: '"deals" acme OUTLET' })] },
    { role: 'assistant', content: null, tool_calls: [call('web_search', { query: 'acme telegram giveaway' })] },
    { role: 'assistant', content: null, tool_calls: [call('report', { candidates: [{ url: 'https://acme-outlet.shop/deals' }] })] },
  ])
  const r = await runSpider({ ...base, nim: second, memory, search: items, read: async url => ({ url, title: 't', text: 'x' }) })
  expect(second.sent[0]![1]!.content).toContain('Acme outlet deals')
  expect(second.sent[1]!.at(-1)!.content).toContain('already ran')
  expect(second.sent[2]!.at(-1)!.content).toContain('already covered')
  expect(r.searches).toBe(1)
  expect(r.hits).toEqual([])
})

test('a page is read once and a site only so often', () => {
  const m = webMemory()
  expect(m.claimRead('https://t.me/a')).toBeNull()
  expect(m.claimRead('https://t.me/a')).toContain('already read')
  expect(m.claimRead('https://t.me/b')).toBeNull()
  expect(m.claimRead('https://t.me/c')).toBeNull()
  expect(m.claimRead('https://t.me/d')).toContain('enough')
})

test('a hunt ends at its search limit, even for agents already out', async () => {
  const nim = scripted([{ role: 'assistant', content: null, tool_calls: [call('web_search', { query: 'one' }), call('web_search', { query: 'two' })] }])
  let n = 0
  const s = spiderSource({ brand: 'Acme', officialDomains: [], nim, maxSearches: 1, search, onSearch: () => n++ })
  const lanes = s.lanes('domains', ['acme'])
  expect(s.over!()).toBeNull()
  await s.search(lanes[0]!)
  expect(n).toBe(1)
  expect(nim.sent[1]!.at(-1)!.content).toContain('limit')
  expect(s.over!()).toContain('1 searches')
  const before = nim.sent.length
  await s.search(lanes[1]!)
  await s.followLead({ kind: 'domain', value: 'x.shop' }, lanes[1]!)
  expect(nim.sent.length).toBe(before)
})

test('a hunt ends when agents stop finding anything new, or nothing is left to start', async () => {
  const nim = scripted([])
  const s = spiderSource({ brand: 'Acme', officialDomains: [], nim })
  for (const surface of ['domains', 'video', 'social'] as const) for (const l of s.lanes(surface, ['a'])) await s.search(l)
  expect(s.over!()).toContain('nothing new')

  let t = 0
  const idle = spiderSource({ brand: 'Acme', officialDomains: [], nim, now: () => t })
  t = 19_000
  expect(idle.over!()).toBeNull()
  idle.touch!()
  t = 38_000
  expect(idle.over!()).toBeNull()
  t = 40_000
  expect(idle.over!()).toContain('anywhere new')
})

test('a resumed hunt keeps its count and does not report old pages again', async () => {
  const nim = scripted([{ role: 'assistant', content: null, tool_calls: [call('web_search', { query: 'fresh angle' })] }, { role: 'assistant', content: null, tool_calls: [call('report', { candidates: [{ url: 'https://acme-outlet.shop/deals' }] })] }])
  const s = spiderSource({ brand: 'Acme', officialDomains: [], nim, maxSearches: 5, search })
  s.restore!({ searches: 4, urls: ['https://acme-outlet.shop/deals'] })
  const r = await s.search(s.lanes('domains', ['a'])[0]!)
  expect(r.hits).toEqual([])
  expect(s.over!()).toContain('5 searches')
})

test('NIM is asked for low reasoning, and rate limits are retried', async () => {
  const bodies: any[] = []
  let n = 0
  const nim = nimClient({ apiKey: 'k', model: 'z-ai/glm-5.3-flash', fetch: (async (_: string, init: any) => {
    bodies.push(JSON.parse(init.body))
    return ++n === 1 ? new Response('busy', { status: 429 }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1000000, completion_tokens: 0 } })
  }) as any, usdPerMInput: 2 })
  const r = await nim.chat([{ role: 'user', content: 'x' }])
  expect(bodies[0].reasoning_effort).toBe('low')
  expect(bodies[0].model).toBe('z-ai/glm-5.3-flash')
  expect(r.usd).toBe(2)
  expect(n).toBe(2)
}, 10_000)

test('the fast spider model is the default and is not sent a reasoning setting', async () => {
  const bodies: any[] = []
  const nim = nimClient({ apiKey: 'k', fetch: (async (_: string, init: any) => { bodies.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }) }) as any })
  await nim.chat([{ role: 'user', content: 'x' }])
  expect(bodies[0].model).toBe(SPIDER_MODEL)
  expect(bodies[0].reasoning_effort).toBeUndefined()
})

test('a slow reasoning model hands the knowledge base to the fast one', async () => {
  const fast = scripted([{ role: 'assistant', content: '{"entries":[{"kind":"domain","value":"acme.com","confidence":0.9}]}' }])
  const slow = { model: 'glm', chat: async () => { throw new Error('timed out') } }
  const { proposals } = await glmKbReasoner({ nim: slow as any, fast: fast as any, search }).buildKb({ brand: 'Acme', keywords: [], officialDomains: [], authorizedSellers: [] })
  expect(proposals.map(p => p.value)).toEqual(['acme.com'])
})

test('one slow page does not hold up the others in a turn', async () => {
  const order: string[] = []
  const nim = scripted([{ role: 'assistant', content: null, tool_calls: [call('read_page', { url: 'https://a.shop/' }), call('read_page', { url: 'https://b.shop/' })] }])
  await runSpider({ ...base, nim, read: async url => { if (url.includes('a.shop')) await Bun.sleep(30); order.push(url); return { url, title: 't', text: 'x' } } })
  expect(order).toEqual(['https://b.shop/', 'https://a.shop/'])
  expect(nim.sent[1]!.filter(m => m.role === 'tool').length).toBe(2)
})

test('every new result goes straight to the classifier, once, with leads kept', async () => {
  const items = async () => [{ url: 'https://www.a.shop/x', title: 'A', snippet: 's' }, { url: 'https://b.shop/', title: 'B', snippet: 's' }]
  const nim = scripted([
    { role: 'assistant', content: null, tool_calls: [call('web_search', { query: 'first' })] },
    { role: 'assistant', content: null, tool_calls: [call('report', { candidates: [{ url: 'https://a.shop/x', leads: [{ kind: 'domain', value: 'c.shop' }] }] })] },
  ])
  const got: string[] = []
  const s = spiderSource({ brand: 'Acme', officialDomains: [], nim, search: items, read: async () => { throw new Error('no page should be read') } })
  const r = await s.search(s.lanes('domains', ['a'])[0]!, async hits => { await Bun.sleep(5); got.push(...hits.map(h => h.url)); return hits.length })
  expect(got).toEqual(['https://www.a.shop/x', 'https://b.shop/'])
  expect(r.hits).toEqual([])
  expect(r.leads).toEqual([{ lead: { kind: 'domain', value: 'c.shop' }, from: 'https://a.shop/x' }])
})

test('a shortlisted result gets its page fetched before the second check', async () => {
  const store = new MemoryStore()
  const input = { brand: 'Acme', keywords: [], officialDomains: [], authorizedSellers: [], budgetUsd: 1, precision: 'balanced' as const }
  await store.hunt('h').init('h', input, 1, 'x')
  const hit = { url: 'https://a.shop/x', surface: 'domains' as const, title: 'A', snippet: 's' }
  await store.kase('c').report('c', 'acme', 'h', hit, 'domains', 1)
  await store.hunt('h').addCase('c')
  await store.kase('c').setTriage({ answers: [], deciderId: 'd', usd: 0, latencyMs: 1, score: 0.99, confidence: 0.9, why: 'y' })
  const texts: string[] = []
  const verify = { id: 'v', price: { usdPerMInput: 0 }, decide: async (e: any) => { texts.push(e.text); return { answers: [], deciderId: 'v', usage: { usd: 0, latencyMs: 1 } } } } as any
  await verifyTick({ huntId: 'h', input, brandSlug: 'acme', store, me: { send: async () => {} } as any, verify, estUsd: 0, capture: async () => 'page words' })
  expect(texts[0]).toContain('page words')
  expect((await store.kase('c').snapshot()).hit!.evidenceText).toBe('page words')
})

test('a burst of decisions waits its turn', async () => {
  let running = 0, peak = 0
  const d = { id: 'x', price: { usdPerMInput: 0 }, decide: async () => { peak = Math.max(peak, ++running); await Bun.sleep(5); running--; return {} } } as any
  const slow = sharedSlots(2)(d)
  await Promise.all([1, 2, 3, 4, 5].map(() => slow.decide({ text: '' }, [])))
  expect(peak).toBe(2)
})

test('search result pages are parsed into real destinations', () => {
  const ddg = `<div class="result__body"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffake.shop%2Fa&amp;rut=1">Fake <b>Shop</b></a><a class="result__snippet" href="x">Cheap &amp; good</a></div>`
  expect(parseDuckDuckGo(ddg)).toEqual([{ url: 'https://fake.shop/a', title: 'Fake Shop', snippet: 'Cheap & good' }])
  const u = `a1${Buffer.from('https://fake.shop/b').toString('base64')}`
  expect(parseBing(`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${u}">B</a></h2><p>Snip</p></li>`)[0]!.url).toBe('https://fake.shop/b')
})

test('pages are reduced to text and cannot reach private addresses, even by redirect', async () => {
  expect(htmlToPage('u', '<title>T</title><script>evil()</script><p>Hello <b>there</b></p>')).toEqual({ url: 'u', title: 'T', text: 'Hello there' })
  for (const ip of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) expect(isPrivateAddress(ip)).toBe(true)
  expect(isPrivateAddress('8.8.8.8')).toBe(false)
  await expect(readPage('http://localhost:3000/')).rejects.toThrow('private')
  await expect(readPage('file:///etc/passwd')).rejects.toThrow('refused')
  const resolve = (async () => [{ address: '93.184.216.34', family: 4 }]) as any
  const redirect = (async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })) as any
  await expect(readPage('https://public.example/', { fetch: redirect, resolve })).rejects.toThrow('private')
})

test('the knowledge base comes from search results and never classifies', async () => {
  const nim = scripted([{ role: 'assistant', content: '{"entries":[{"kind":"domain","value":"https://www.acme.com/","confidence":0.95,"evidence":"top result"},{"kind":"nonsense","value":"x"}]}' }])
  const r = glmKbReasoner({ nim, search })
  const { proposals } = await r.buildKb({ brand: 'Acme', keywords: [], officialDomains: [], authorizedSellers: [] })
  expect(proposals).toEqual([{ kind: 'domain', value: 'acme.com', confidence: 0.95, evidence: 'top result' }])
  expect(r.kbOnly).toBe(true)
})

test('off-topic fallback results are dropped', () => {
  const item = (url: string, title = 'x') => ({ url, title, snippet: '' })
  expect(onTopic('site:dhgate.com reebok shoes', [item('https://www.reebok.com/', 'Reebok shoes'), item('https://www.dhgate.com/p/1', 'Reebok shoes')]).map(i => i.url)).toEqual(['https://www.dhgate.com/p/1'])
  expect(onTopic('reebok replica telegram', [item('https://www.reebok.com/', 'Reebok'), item('https://x.shop/a', 'Reebok replica')]).map(i => i.url)).toEqual(['https://x.shop/a'])
})

test('when DuckDuckGo stops answering it is rested, and search says so', async () => {
  const asked: string[] = []
  const f = (async (url: string) => {
    asked.push(new URL(url).hostname)
    if (url.includes('duckduckgo')) throw new Error('timed out')
    return new Response('<li class="b_algo"><h2><a href="https://fake.shop/a">Acme replica</a></h2><p>x</p></li>')
  }) as any
  let t = Date.now()
  expect((await searchOnce('acme replica', { f, now: () => t })).map(i => i.url)).toEqual(['https://fake.shop/a'])
  expect(searchDegraded()).toBe(true)
  await searchOnce('acme replica', { f, now: () => t })
  expect(asked).toEqual(['html.duckduckgo.com', 'www.bing.com', 'www.bing.com'])
})

test('a search API key is used in place of scraping', async () => {
  const f = (async (url: string, init: any) => {
    expect(url).toContain('api.search.brave.com')
    expect(init.headers['x-subscription-token']).toBe('k')
    return Response.json({ web: { results: [{ url: 'https://fake.shop/a', title: '<b>A</b>', description: 'd' }] } })
  }) as any
  expect(await searchOnce('acme', { f, braveKey: 'k' })).toEqual([{ url: 'https://fake.shop/a', title: 'A', snippet: 'd' }])
  expect(parseBrave({})).toEqual([])
})
