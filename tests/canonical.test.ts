import { expect, test } from 'bun:test'
import { canonicalUrl, caseId } from '../src/core/canonical'
import { encodeTag, parseTag } from '../src/core/tags'

test('variants of a listing share one canonical URL', () => {
  const want = 'https://shop.example/item/42?color=red&size=l'
  for (const raw of [
    'https://SHOP.example/item/42/?size=l&color=red',
    'https://www.shop.example/item/42?color=red&size=l&utm_source=x&gclid=1',
    'http://shop.example/item/42?size=l&fbclid=abc&color=red#reviews',
    'shop.example/item/42?ref=aff&color=red&size=l',
  ]) expect(canonicalUrl(raw)).toBe(want)
})

test('known short links normalise through a provided expansion', () => {
  const expand = { 'https://bit.ly/abc': 'https://shop.example/item/42' }
  expect(canonicalUrl('https://bit.ly/abc?utm_source=x', expand)).toBe('https://shop.example/item/42')
})

test('an unparseable URL does not throw and stays stable', () => {
  expect(canonicalUrl('  not a url  ')).toBe(canonicalUrl('not a url'))
})

test('case id depends on brand and canonical URL only', () => {
  expect(caseId('tesla', 'https://www.a.example/x/?utm_medium=y')).toBe(caseId('tesla', 'https://a.example/x'))
  expect(caseId('tesla', 'https://a.example/x')).not.toBe(caseId('musk', 'https://a.example/x'))
})

test('tag codec round trips and rejects junk without throwing', () => {
  const text = encodeTag('STEER', { lane: { source: 'video' }, reason: 'yield' })
  expect(parseTag(text)).toEqual({ tag: 'STEER', payload: { lane: { source: 'video' }, reason: 'yield' } })
  for (const bad of ['', 'hello', 'STEER', 'STEER {nope', 'BOGUS {}', 'STEER [1]', 'STEER null'])
    expect(parseTag(bad)).toBeNull()
})
