import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { CaseState } from '../core/machines/case'
import { join } from 'node:path'
import { brand, initialBrand } from '../core/machines/brand'
import { kase, initialCase } from '../core/machines/case'
import { hunt, initialHunt } from '../core/machines/hunt'
import { playbook, initialPlaybook } from '../core/machines/playbook'
import type { Client, Store } from './types'

/**
 * Same one-call-at-a-time semantics as an actor, for tests and offline runs.
 * The machines are synchronous, so each method applies atomically.
 * Pass a directory to persist state to disk across restarts.
 */
export class MemoryStore implements Store {
  private states = new Map<string, unknown>()
  constructor(private dir?: string) {
    if (dir) mkdirSync(dir, { recursive: true })
  }

  private client<M extends Record<string, any>>(key: string, machine: M, init: () => unknown): Client<M> {
    return new Proxy({}, {
      get: (_, method: string) => async (...args: unknown[]) => {
        const [next, result] = machine[method](this.load(key, init), ...args)
        this.save(key, next)
        // Clone so callers cannot mutate actor state, matching a wire call.
        return result === undefined ? result : structuredClone(result)
      },
    }) as Client<M>
  }

  private load(key: string, init: () => unknown) {
    if (!this.states.has(key)) {
      const f = this.file(key)
      this.states.set(key, f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : init())
    }
    return this.states.get(key)
  }

  private save(key: string, state: unknown) {
    if (this.states.get(key) === state) return
    this.states.set(key, state)
    const f = this.file(key)
    if (f) {
      writeFileSync(`${f}.tmp`, JSON.stringify(state))
      renameSync(`${f}.tmp`, f)
    }
  }

  private file = (key: string) => (this.dir ? join(this.dir, `${encodeURIComponent(key)}.json`) : null)

  hunt = (id: string) => this.client(`hunt:${id}`, hunt, initialHunt)
  kase = (id: string) => this.client(`case:${id}`, kase, initialCase)
  cases = (ids: string[]) => Promise.all(ids.map(id => this.kase(id).snapshot()))
  brand = (s: string) => this.client(`brand:${s}`, brand, initialBrand)
  brandCases = async (s: string, limit: number) => {
    const onDisk = this.dir ? readdirSync(this.dir).map(f => decodeURIComponent(f.replace(/\.json$/, ''))) : []
    const keys = [...new Set([...this.states.keys(), ...onDisk])].filter(k => k.startsWith('case:'))
    const all = await this.cases(keys.map(k => k.slice('case:'.length)))
    const flagged = (c: CaseState) => (['verified', 'awaiting_approval', 'approved'].includes(c.state) ? 0 : 1)
    return all.filter(c => c.brand === s).sort((a, b) => flagged(a) - flagged(b)).slice(0, limit)
  }
  playbook = () => this.client('playbook:global', playbook, initialPlaybook)
}
