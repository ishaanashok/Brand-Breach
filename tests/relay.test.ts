import { describe, expect, test } from 'bun:test'
import { addressDm, readDm, withBackoff } from '../src/relay/sdk'

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
