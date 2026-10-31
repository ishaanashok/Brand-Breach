import { Actor, Persisted } from 'durable-actors'
import { brand, initialBrand, type BrandState, type Edge, type Label, type LaneStat } from './core/machines/brand.js'
import { kase, initialCase, type CaseState, type DecisionRecord, type Reasoning, type Verification } from './core/machines/case.js'
import { hunt, initialHunt, type Counters, type HuntState, type HuntStatus, type ReserveResult, type Spawn, type SteerKind } from './core/machines/hunt.js'
import type { KbEntity } from './core/kb.js'
import { playbook, initialPlaybook, type PlaybookState } from './core/machines/playbook.js'
import type { Hit, HuntInput, Lane } from './core/types.js'

// Actors only hold state and apply rules from the machines; they never call a model.
// Each method reassigns `s` whole because nested mutations are not persisted.

export class Hunt extends Actor {
  @Persisted s: HuntState = initialHunt()
  #run<R>([next, r]: [HuntState, R]): R { this.s = next; return r }

  async init(id: string, input: HuntInput, now: number, mode = ''): Promise<HuntState> { return this.#run(hunt.init(this.s, id, input, now, mode)) }
  async reserve(scout: string, usd: number, now: number): Promise<ReserveResult> { return this.#run(hunt.reserve(this.s, scout, usd, now)) }
  async settle(id: string, actualUsd: number): Promise<{ spent: number }> { return this.#run(hunt.settle(this.s, id, actualUsd)) }
  async registerScout(name: string, lane: Lane, now: number): Promise<Lane> { return this.#run(hunt.registerScout(this.s, name, lane, now)) }
  async setScoutStatus(name: string, status: string, now: number): Promise<null> { return this.#run(hunt.setScoutStatus(this.s, name, status, now)) }
  async setLane(name: string, lane: Lane, reason: string, now: number, kind?: SteerKind): Promise<null> { return this.#run(hunt.setLane(this.s, name, lane, reason, now, kind)) }
  async setStatus(status: HuntStatus): Promise<HuntStatus> { return this.#run(hunt.setStatus(this.s, status)) }
  async setBudget(usd: number): Promise<number> { return this.#run(hunt.setBudget(this.s, usd)) }
  async bump(counter: keyof Counters, by = 1): Promise<number> { return this.#run(hunt.bump(this.s, counter, by)) }
  async markFirstVerified(now: number): Promise<null> { return this.#run(hunt.markFirstVerified(this.s, now)) }
  async addCase(caseId: string): Promise<null> { return this.#run(hunt.addCase(this.s, caseId)) }
  async recordSpawn(spawn: Spawn): Promise<null> { return this.#run(hunt.recordSpawn(this.s, spawn)) }
  async finishSpawn(agent: string, caseId: string, outcome: string, now: number): Promise<null> { return this.#run(hunt.finishSpawn(this.s, agent, caseId, outcome, now)) }
  async log(text: string, now: number): Promise<null> { return this.#run(hunt.log(this.s, text, now)) }
  async snapshot(): Promise<HuntState> { return this.s }
}

export class Case extends Actor {
  @Persisted s: CaseState = initialCase()
  #run<R>([next, r]: [CaseState, R]): R { this.s = next; return r }

  async report(id: string, brandSlug: string, huntId: string, h: Hit, reporter: string, now: number): Promise<{ first: boolean; state: CaseState['state'] }> { return this.#run(kase.report(this.s, id, brandSlug, huntId, h, reporter, now)) }
  async skip(reason: string): Promise<null> { return this.#run(kase.skip(this.s, reason)) }
  async setTriage(t: DecisionRecord): Promise<null> { return this.#run(kase.setTriage(this.s, t)) }
  async markUndecided(reason: string): Promise<null> { return this.#run(kase.markUndecided(this.s, reason)) }
  async shortlist(): Promise<boolean> { return this.#run(kase.shortlist(this.s)) }
  async addEvidence(text: string): Promise<null> { return this.#run(kase.addEvidence(this.s, text)) }
  async setVerification(r: Verification): Promise<null> { return this.#run(kase.setVerification(this.s, r)) }
  async claimReasoning(agent: string, trigger: Reasoning['trigger'], now: number, staleMs: number): Promise<boolean> { return this.#run(kase.claimReasoning(this.s, agent, trigger, now, staleMs)) }
  async failReasoning(error: string): Promise<null> { return this.#run(kase.failReasoning(this.s, error)) }
  async setReasoning(r: Pick<Reasoning, 'reasonerId' | 'verdict' | 'confidence' | 'reasoning' | 'usd' | 'latencyMs'>): Promise<{ state: CaseState['state']; newlyVerified: boolean }> { return this.#run(kase.setReasoning(this.s, r)) }
  async draftNotice(notice: string): Promise<null> { return this.#run(kase.draftNotice(this.s, notice)) }
  async decide(decision: 'approve' | 'reject', by: string, now: number): Promise<{ changed: boolean; state: CaseState['state'] }> { return this.#run(kase.decide(this.s, decision, by, now)) }
  async recheck(result: string, now: number): Promise<null> { return this.#run(kase.recheck(this.s, result, now)) }
  async snapshot(): Promise<CaseState> { return this.s }
}

/**
 * Holds many cases, because the local runtime runs one process per live actor and a hunt finds hundreds of pages.
 * Calls still run one at a time, so a case keeps the same guarantees it had as its own actor.
 */
export class CaseShard extends Actor {
  @Persisted cases: Record<string, CaseState> = {}
  #run<R>(id: string, step: (s: CaseState) => [CaseState, R]): R {
    const before = this.cases[id] ?? initialCase()
    const [next, r] = step(before)
    if (next !== before) this.cases = { ...this.cases, [id]: next }
    return r
  }

  async report(key: string, id: string, brandSlug: string, huntId: string, h: Hit, reporter: string, now: number): Promise<{ first: boolean; state: CaseState['state'] }> { return this.#run(key, s => kase.report(s, id, brandSlug, huntId, h, reporter, now)) }
  async skip(key: string, reason: string): Promise<null> { return this.#run(key, s => kase.skip(s, reason)) }
  async setTriage(key: string, t: DecisionRecord): Promise<null> { return this.#run(key, s => kase.setTriage(s, t)) }
  async markUndecided(key: string, reason: string): Promise<null> { return this.#run(key, s => kase.markUndecided(s, reason)) }
  async shortlist(key: string): Promise<boolean> { return this.#run(key, s => kase.shortlist(s)) }
  async addEvidence(key: string, text: string): Promise<null> { return this.#run(key, s => kase.addEvidence(s, text)) }
  async setVerification(key: string, r: Verification): Promise<null> { return this.#run(key, s => kase.setVerification(s, r)) }
  async claimReasoning(key: string, agent: string, trigger: Reasoning['trigger'], now: number, staleMs: number): Promise<boolean> { return this.#run(key, s => kase.claimReasoning(s, agent, trigger, now, staleMs)) }
  async failReasoning(key: string, error: string): Promise<null> { return this.#run(key, s => kase.failReasoning(s, error)) }
  async setReasoning(key: string, r: Pick<Reasoning, 'reasonerId' | 'verdict' | 'confidence' | 'reasoning' | 'usd' | 'latencyMs'>): Promise<{ state: CaseState['state']; newlyVerified: boolean }> { return this.#run(key, s => kase.setReasoning(s, r)) }
  async draftNotice(key: string, notice: string): Promise<null> { return this.#run(key, s => kase.draftNotice(s, notice)) }
  async decide(key: string, decision: 'approve' | 'reject', by: string, now: number): Promise<{ changed: boolean; state: CaseState['state'] }> { return this.#run(key, s => kase.decide(s, decision, by, now)) }
  async recheck(key: string, result: string, now: number): Promise<null> { return this.#run(key, s => kase.recheck(s, result, now)) }
  async snapshot(key: string): Promise<CaseState> { return this.cases[key] ?? initialCase() }
  async snapshotMany(keys: string[]): Promise<CaseState[]> { return keys.map(k => this.cases[k] ?? initialCase()) }
}

export class Brand extends Actor {
  @Persisted s: BrandState = initialBrand()
  #run<R>([next, r]: [BrandState, R]): R { this.s = next; return r }

  async configure(slug: string, officialDomains: string[], authorizedSellers: string[]): Promise<BrandState> { return this.#run(brand.configure(this.s, slug, officialDomains, authorizedSellers)) }
  async addEdges(edges: Edge[]): Promise<number> { return this.#run(brand.addEdges(this.s, edges)) }
  async recordLaneOutcome(lane: string, d: LaneStat): Promise<LaneStat> { return this.#run(brand.recordLaneOutcome(this.s, lane, d)) }
  async addLabel(l: Label): Promise<boolean> { return this.#run(brand.addLabel(this.s, l)) }
  async markSeen(url: string, r: { score: number; state: string }): Promise<null> { return this.#run(brand.markSeen(this.s, url, r)) }
  async getSeen(url: string): Promise<{ score: number; state: string } | null> { return this.#run(brand.getSeen(this.s, url)) }
  async setKb(entities: KbEntity[], builtBy: string, now: number): Promise<number> { return this.#run(brand.setKb(this.s, entities, builtBy, now)) }
  async addKbEntity(e: KbEntity): Promise<null> { return this.#run(brand.addKbEntity(this.s, e)) }
  async removeKbEntity(id: string): Promise<null> { return this.#run(brand.removeKbEntity(this.s, id)) }
  async getThreshold(deciderId: string): Promise<number> { return this.#run(brand.getThreshold(this.s, deciderId)) }
  async getLaneStats(): Promise<Record<string, LaneStat>> { return this.#run(brand.getLaneStats(this.s)) }
  async snapshot(): Promise<BrandState> { return this.s }
}

export class Playbook extends Actor {
  @Persisted s: PlaybookState = initialPlaybook()
  #run<R>([next, r]: [PlaybookState, R]): R { this.s = next; return r }

  async update(lane: string, d: LaneStat): Promise<null> { return this.#run(playbook.update(this.s, lane, d)) }
  async getPriors(): Promise<Record<string, LaneStat>> { return this.#run(playbook.getPriors(this.s)) }
  async registerHunt(id: string): Promise<null> { return this.#run(playbook.registerHunt(this.s, id)) }
  async listHunts(): Promise<string[]> { return this.#run(playbook.listHunts(this.s)) }
  async snapshot(): Promise<PlaybookState> { return this.s }
}
