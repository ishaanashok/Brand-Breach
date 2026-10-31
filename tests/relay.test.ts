import { describe, expect, test } from 'bun:test'
import { caseId, caseShard } from '../src/core/case-id'
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

describe('caseShard', () => {
  test('spreads a brand over 16 actors at most', () => {
    const shards = new Set(Array.from({ length: 500 }, (_, i) => caseShard(caseId('air-max', `https://a.example/${i}`))))
    expect(shards.size).toBeLessThanOrEqual(16)
    expect([...shards].every(s => s!.startsWith('air-max-'))).toBe(true)
  })

  test('leaves older ids on their own actors', () => {
    expect(caseShard('case_3f5ca2a5904add68c794b7b4')).toBeNull()
  })
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
