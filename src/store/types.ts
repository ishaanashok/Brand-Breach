import type { brand } from '../core/machines/brand'
import type { CaseState, kase } from '../core/machines/case'
import type { hunt } from '../core/machines/hunt'
import type { playbook } from '../core/machines/playbook'

/** Turns a machine's `(state, ...args) => [state, result]` methods into async client methods. */
export type Client<M> = {
  [K in keyof M]: M[K] extends (s: any, ...a: infer A) => [any, infer R] ? (...a: A) => Promise<R> : never
}

export type HuntClient = Client<typeof hunt>
export type CaseClient = Client<typeof kase>
export type BrandClient = Client<typeof brand>
export type PlaybookClient = Client<typeof playbook>

export interface Store {
  hunt(id: string): HuntClient
  kase(id: string): CaseClient
  /** Many cases in input order, in as few calls as the store allows. */
  cases(ids: string[]): Promise<CaseState[]>
  brand(slug: string): BrandClient
  playbook(): PlaybookClient
}
