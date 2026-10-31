import { expect, test } from 'bun:test'
import { rulesCheck } from '../src/core/rules'
import { rankShortlist, thresholdFor } from '../src/core/policy'
import { draftNotice } from '../src/core/notice'
import { rankLanes, chooseSteer } from '../src/core/lanes'
import { redact } from '../src/core/redact'

const ctx = { officialDomains: ['tesla.com'], authorizedSellers: ['Tesla Parts Co'], whitelist: ['good-shop'] }
const hit = (over = {}) => ({ url: 'https://x.example/a', surface: 'marketplace' as const, title: 't', snippet: 's', ...over })

test('stage 0 skips official domains and authorized sellers for free', () => {
  expect(rulesCheck(hit({ url: 'https://shop.tesla.com/item' }), ctx).skip).toBe('official domain')
  expect(rulesCheck(hit({ seller: 'tesla parts co' }), ctx).skip).toBe('authorized seller')
  expect(rulesCheck(hit({ seller: 'good-shop' }), ctx).skip).toBe('whitelisted seller')
  // A lookalike must not pass as official.
  expect(rulesCheck(hit({ url: 'https://tesla.com.promo.example/x' }), ctx).skip).toBeNull()
})

test('stage 0 raises a price flag on a steep discount', () => {
  expect(rulesCheck(hit({ price: 10, listPrice: 100 }), ctx).priceFlag).toBe(true)
  expect(rulesCheck(hit({ price: 90, listPrice: 100 }), ctx).priceFlag).toBe(false)
})

test('shortlist ranks by value per dollar and respects budget and threshold', () => {
  const cs = [
    { id: 'cheap', p: 0.8, severity: 1, estCostUsd: 0.001 },
    { id: 'pricey', p: 0.9, severity: 1, estCostUsd: 0.01 },
    { id: 'weak', p: 0.2, severity: 1, estCostUsd: 0.001 },
  ]
  expect(rankShortlist(cs, { threshold: 0.5, remainingUsd: 1 }).map(c => c.id)).toEqual(['cheap', 'pricey'])
  expect(rankShortlist(cs, { threshold: 0.5, remainingUsd: 0.002 }).map(c => c.id)).toEqual(['cheap'])
  expect(rankShortlist([], { threshold: 0.5, remainingUsd: 1 })).toEqual([])
})

test('precision setting moves the threshold', () => {
  expect(thresholdFor(0.5, 'recall')).toBeLessThan(thresholdFor(0.5, 'balanced'))
  expect(thresholdFor(0.5, 'precision')).toBeGreaterThan(thresholdFor(0.5, 'balanced'))
})

test('notices use candidate wording and state they are unsent drafts', () => {
  const n = draftNotice({ brand: 'Tesla', url: 'https://x.example/a', surface: 'video', why: 'giveaway language', score: 0.9 })
  expect(n).toContain('candidate')
  expect(n).toContain('https://x.example/a')
  expect(n).toMatch(/draft/i)
  expect(n).not.toMatch(/\b(criminal|fraudster|guilty|illegal)\b/i)
})

test('lanes rank by hits per dollar with an exploration bonus', () => {
  const stats = { 'video/a': { tries: 10, hits: 8, costUsd: 0.1 }, 'video/b': { tries: 10, hits: 1, costUsd: 0.1 } }
  const r = rankLanes(['video/a', 'video/b', 'video/new'], stats)
  expect(r.indexOf('video/a')).toBeLessThan(r.indexOf('video/b'))
  expect(r.indexOf('video/new')).toBeLessThan(r.indexOf('video/b'))
})

test('steer picks a better lane, rate limits, and carries a reason', () => {
  const stats = { 'video/good': { tries: 10, hits: 8, costUsd: 0.1 }, 'video/bad': { tries: 10, hits: 0, costUsd: 0.1 } }
  const lanes = [{ source: 'video' as const, strategy: 'good', query: 'q' }, { source: 'video' as const, strategy: 'bad', query: 'q' }]
  const cur = lanes[1]!
  const s = chooseSteer({ current: cur, candidates: lanes, stats, lastSteerAt: 0, now: 30_000, taken: [] })
  expect(s?.lane.strategy).toBe('good')
  expect(s?.reason).toContain('per dollar')
  expect(chooseSteer({ current: cur, candidates: lanes, stats, lastSteerAt: 25_000, now: 30_000, taken: [] })).toBeNull()
  expect(chooseSteer({ current: lanes[0]!, candidates: lanes, stats, lastSteerAt: 0, now: 30_000, taken: [] })).toBeNull()
})

test('redact blurs wallets and handles for display', () => {
  const r = redact('send to 0x52908400098527886E0F7030069857D2E4169EE7 or bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq, ask @scam_admin or t.me/fakegroup; mail a@b.example')
  expect(r).not.toContain('0x5290840')
  expect(r).not.toContain('bc1qar0')
  expect(r).not.toContain('scam_admin')
  expect(r).not.toContain('fakegroup')
  expect(r).toContain('a@b.example')
})
