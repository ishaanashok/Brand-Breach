import { expect, test } from 'bun:test'
import { nimClient, runSpider, spiderSource, type ChatMessage } from '../src/harness/spiders'
import { glmKbReasoner } from '../src/reasoners/glm'
import { htmlToPage, isPrivateAddress, parseBing, parseDuckDuckGo, readPage } from '../src/harness/web'

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

test('NIM is asked for low reasoning, and rate limits are retried', async () => {
  const bodies: any[] = []
  let n = 0
  const nim = nimClient({ apiKey: 'k', fetch: (async (_: string, init: any) => {
    bodies.push(JSON.parse(init.body))
    return ++n === 1 ? new Response('busy', { status: 429 }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1000000, completion_tokens: 0 } })
  }) as any, usdPerMInput: 2 })
  const r = await nim.chat([{ role: 'user', content: 'x' }])
  expect(bodies[0].reasoning_effort).toBe('low')
  expect(bodies[0].model).toBe('z-ai/glm-5.3-flash')
  expect(r.usd).toBe(2)
  expect(n).toBe(2)
}, 10_000)

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
