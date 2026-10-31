import { describe, expect, test } from 'bun:test'
import { caseBrand, caseId } from '../src/core/case-id'
import { wellFormed } from '../src/store/actors'
import { addressDm, outbox, readDm, withBackoff } from '../src/relay/sdk'

describe('outbox', () => {
  test('sends direct messages first and drops the oldest channel posts', async () => {
    const sent: string[] = []
    let release = () => {}
    const box = outbox(1, 2)
    box.add('#hunt', () => new Promise<void>(r => { release = r }))
    for (const n of ['a', 'b', 'c']) box.add('#hunt', async () => { sent.push(n) })
    box.add('@video', async () => { sent.push('steer') })
    release()
    await Bun.sleep(5)
    expect(sent).toEqual(['steer', 'b', 'c'])
  })

  test('a failed send does not stop the next one', async () => {
    const sent: string[] = []
    const box = outbox(1)
    box.add('@a', async () => { throw new Error('nope') })
    box.add('@b', async () => { sent.push('b') })
    await Bun.sleep(5)
    expect(sent).toEqual(['b'])
  })
})

describe('caseBrand', () => {
  test('puts every page of a brand on that brand', () => {
    const brands = new Set(Array.from({ length: 500 }, (_, i) => caseBrand(caseId('air--max', `https://a.example/${i}`))))
    expect([...brands]).toEqual(['air--max'])
  })
})

test('text cut mid-character can still be sent as JSON', () => {
  const cut = '😀'.slice(0, 1)
  const out = wellFormed({ hit: { snippet: `a${cut}`, tags: [cut] }, n: 1, none: null })
  expect(out.hit.snippet.isWellFormed()).toBe(true)
  expect(out.hit.tags[0]!.isWellFormed()).toBe(true)
  expect(out.n).toBe(1)
  expect(out.none).toBeNull()
})

describe('withBackoff', () => {
  test('retries a busy workspace until the write lands', async () => {
    let n = 0
    const out = await withBackoff(async () => {
      if (++n < 3) throw new Error('RelayError: Workspace write capacity is busy; retry with backoff')
      return 'ok'
    }, 6, 1)
    expect(out).toBe('ok')
    expect(n).toBe(3)
  })

  test('honours a retryable error and its stated wait', async () => {
    let n = 0
    const err = Object.assign(new Error('Workspace write admission is temporarily unavailable'), { retryable: true, retryAfterMs: 1 })
    expect(await withBackoff(async () => { if (++n < 2) throw err; return 'ok' }, 3, 1)).toBe('ok')
  })

  test('does not retry a real failure', async () => {
    let n = 0
    await expect(withBackoff(async () => { n++; throw new Error('Agent "x" not found') }, 6, 1)).rejects.toThrow('not found')
    expect(n).toBe(1)
  })

  test('gives up after the last try', async () => {
    let n = 0
    await expect(withBackoff(async () => { n++; throw new Error('capacity is busy') }, 3, 1)).rejects.toThrow('busy')
    expect(n).toBe(3)
  })
})

describe('DM addressing', () => {
  test('round-trips the recipient and the text, including newlines', () => {
    expect(readDm(addressDm('@video', 'STEER {"a":1}\nmore'))).toEqual({ to: '@video', text: 'STEER {"a":1}\nmore' })
  })

  test('a DM from outside the bus keeps its text and reaches nobody by name', () => {
    expect(readDm('hello')).toEqual({ to: '@unknown', text: 'hello' })
  })
})
