import { REASONER_STALE_MS, type Escalation } from '../core/escalate'
import { rankLanes } from '../core/lanes'
import type { CaseState } from '../core/machines/case'
import { DEFAULT_THRESHOLD } from '../core/machines/brand'
import { thresholdFor } from '../core/policy'
import { encodeTag, parseTag } from '../core/tags'
import { SURFACES, laneKey, slug, type Decider, type HuntInput, type Lane, type Surface } from '../core/types'
import { HUNT_CHANNEL, REVIEW_CHANNEL, type Bus, type Participant } from '../relay/types'
import type { Reasoner } from '../reasoners/types'
import type { Store } from '../store/types'
import { createOrchestrator } from './orchestrator'
import { ensureKb } from './kb-builder'
import { runReasoner } from './reasoner-agent'
import { Scout } from './scout'
import type { Source } from './source'
import { verifyTick } from './verifier'

export type Timing = { scoutDelayMs: number; tickMs: number; cooldownMs: number; verifyMs: number }
const REASONER_SLOTS = ['reasoner-1', 'reasoner-2']
export const DEMO_TIMING: Timing = { scoutDelayMs: 1500, tickMs: 8000, cooldownMs: 20_000, verifyMs: 2000 }
/** Real agents wait on the web and the models, so pausing between steps only adds to that. */
export const SPIDER_TIMING: Timing = { scoutDelayMs: 200, tickMs: 1500, cooldownMs: 2000, verifyMs: 750 }

export type RunnerDeps = {
  store: Store; bus: Bus; source: Source; triage: Decider; verify: Decider
  verifyEstUsd: number; timing: Timing
  /** Without one the hunt runs on decisions alone, with no knowledge base build or escalation. */
  reasoner?: Reasoner
}

/** Hosts one hunt's scouts, orchestrator and verifier. All of it is rebuilt from actors on resume. */
export class HuntRunner {
  private scouts: Scout[] = []
  private stopped = false
  private loops: Promise<unknown>[] = []
  private unsub = () => {}
  private human?: Participant
  private input!: HuntInput
  private brandSlug = ''
  private launching: Promise<unknown> = Promise.resolve()
  private freeSlots = [...REASONER_SLOTS]
  private reasoners = new Set<Promise<unknown>>()
  private participants = new Map<string, Participant>()

  constructor(public huntId: string, private d: RunnerDeps) {}

  async start(input: HuntInput) {
    const { store } = this.d
    await store.playbook().registerHunt(this.huntId)
    await store.hunt(this.huntId).init(this.huntId, input, Date.now(), this.d.triage.id)
    await store.brand(slug(input.brand)).configure(slug(input.brand), input.officialDomains, input.authorizedSellers)
    // Joining Relay can take a while under load, so the hunt is visible before it finishes.
    this.launching = this.launch(input, true).catch(async err => {
      await store.hunt(this.huntId).log(`could not start: ${err}`, Date.now())
      await store.hunt(this.huntId).setStatus('done')
    })
  }

  async resume() {
    const h = await this.d.store.hunt(this.huntId).snapshot()
    if (!h.input) throw new Error(`unknown hunt ${this.huntId}`)
    await this.launch(h.input, false)
  }

  private lanesFor = (s: Surface) => this.d.source.lanes(s, this.input.keywords)

  /** The best remembered lane for each scout; unknown lanes keep source order. */
  private async initialLanes(): Promise<Record<Surface, Lane>> {
    const [brandStats, priors] = await Promise.all([
      this.d.store.brand(this.brandSlug).getLaneStats(),
      this.d.store.playbook().getPriors(),
    ])
    const stats = { ...priors, ...brandStats }
    const out = {} as Record<Surface, Lane>
    for (const s of SURFACES) {
      const lanes = this.lanesFor(s)
      const known = lanes.map(laneKey).filter(k => stats[k]?.tries)
      const pick = known.length ? rankLanes(known, stats)[0]! : laneKey(lanes[0]!)
      out[s] = lanes.find(l => laneKey(l) === pick)!
    }
    return out
  }

  private async launch(input: HuntInput, announce: boolean) {
    this.input = input
    this.brandSlug = slug(input.brand)
    const { store, bus } = this.d
    const orchestratorMe = await bus.register('orchestrator')
    this.human = await bus.register('reviewer')
    const verifierMe = await bus.register('verifier')

    this.unsub = bus.onMessage(m => {
      const p = parseTag(m.text)
      if (!p) return
      if (p.tag === 'DECISION') this.decide(p.payload.caseId, p.payload.decision, m.from).catch(() => {})
    })

    // Scouts start only once the real sites are known, so none are flagged or paid for.
    if (this.d.reasoner && announce) await ensureKb({ huntId: this.huntId, input, brandSlug: this.brandSlug, store, reasoner: this.d.reasoner, me: orchestratorMe })

    const known = await store.hunt(this.huntId).snapshot()
    const caseUrls = await Promise.all(known.caseIds.map(async id => (await store.kase(id).snapshot()).hit?.url))
    this.d.source.restore?.({
      searches: known.counters.searches ?? 0,
      urls: [...caseUrls.filter((u): u is string => !!u), ...Object.keys((await store.brand(this.brandSlug).snapshot()).seen)],
    })

    const lanes = await this.initialLanes()
    const common = { huntId: this.huntId, input, brandSlug: this.brandSlug, store, bus, source: this.d.source, triage: this.d.triage, delayMs: this.d.timing.scoutDelayMs }
    this.scouts = SURFACES.map(s => new Scout(s, common, lanes[s]))
    await Promise.all(this.scouts.map(s => s.connect()))
    for (const s of this.scouts) this.loops.push(this.superviseScout(s, !announce))
    // Scouts take their lane from the Hunt actor, so ASSIGN only announces it. A resume stays silent.
    if (announce) for (const s of SURFACES) await orchestratorMe.send(`@${s}`, encodeTag('ASSIGN', { lane: lanes[s], budgetSliceUsd: input.budgetUsd / SURFACES.length }))

    const orch = createOrchestrator({ huntId: this.huntId, input, brandSlug: this.brandSlug, store, me: orchestratorMe, lanes: this.lanesFor, cooldownMs: this.d.timing.cooldownMs,
      ...(this.d.reasoner && !this.d.reasoner.kbOnly ? { spawnReasoner: (c: CaseState, e: Escalation) => this.spawnReasoner(c, e, orchestratorMe), slots: () => this.freeSlots.length } : {}) })
    this.every(this.d.timing.tickMs, () => orch.tick())
    this.every(this.d.timing.verifyMs, () => orch.escalate())
    this.every(this.d.timing.verifyMs, async () => {
      const n = await verifyTick({ huntId: this.huntId, input, brandSlug: this.brandSlug, store, me: verifierMe, verify: this.d.verify, estUsd: this.d.verifyEstUsd, capture: this.d.source.capture })
      const now = await store.hunt(this.huntId).snapshot()
      if (now.status === 'paused') this.d.source.touch?.()
      const over = this.d.source.over?.() ?? null
      if (n === 0 && !this.reasoners.size && (over ? !(await this.hasUnclassified()) : !this.d.source.busy?.() && await orch.finished()) && !(await this.hasTriaged()) && !(await orch.escalations()).length) {
        const h = await store.hunt(this.huntId).snapshot()
        if (h.status !== 'running') return
        const caveat = this.d.source.caveat?.()
        await store.hunt(this.huntId).log(`Finished: ${over ?? 'every lane has been searched'}.${caveat ? ` ${caveat}` : ''}`, Date.now())
        await store.hunt(this.huntId).setStatus('done')
      }
    })
  }

  /** A scout holds nothing worth keeping, so losing the actor runtime for a while costs only the time. */
  private async superviseScout(s: Scout, recover: boolean) {
    const hunt = this.d.store.hunt(this.huntId)
    while (!this.stopped) {
      try {
        if (recover) await this.recoverStranded(s.name)
        await s.run()
        return
      } catch (err) {
        await hunt.log(`${s.name} crashed, restarting: ${err}`, Date.now()).catch(() => {})
        recover = true
        await Bun.sleep(this.d.timing.tickMs)
      }
    }
  }

  private async recoverStranded(surface: Surface) {
    const { caseIds } = await this.d.store.hunt(this.huntId).snapshot()
    const cases = await Promise.all(caseIds.map(id => this.d.store.kase(id).snapshot()))
    const stranded = cases.filter(c => c.state === 'new' && c.hit!.surface === surface)
    if (stranded.length) await this.d.store.hunt(this.huntId).log(`Recovering ${stranded.length} cases left untriaged by a crash`, Date.now())
    const scout = this.scouts.find(s => s.name === surface)!
    for (const c of stranded) await scout.recover(c)
  }

  /** The orchestrator's call: a short-lived agent with its own place on the bus and its own budget hold. */
  private async spawnReasoner(c: CaseState, e: Escalation, orchestrator: Participant): Promise<boolean> {
    const reasoner = this.d.reasoner!
    const hunt = this.d.store.hunt(this.huntId)
    const agent = this.freeSlots.shift()
    if (!agent) return true
    const release = () => { this.freeSlots.push(agent) }
    const r = await hunt.reserve(agent, reasoner.assessEstUsd, Date.now())
    if (!r.ok) { release(); return false }
    if (!(await this.d.store.kase(c.id).claimReasoning(agent, e.trigger, Date.now(), REASONER_STALE_MS))) {
      await hunt.settle(r.id!, 0)
      release()
      return true
    }
    const me = this.participants.get(agent) ?? await this.d.bus.register(agent)
    this.participants.set(agent, me)
    await hunt.recordSpawn({ agent, caseId: c.id, trigger: e.trigger, reasonerId: reasoner.id, at: Date.now() })
    await orchestrator.send(HUNT_CHANNEL, encodeTag('SPAWN', { agent, caseId: c.id, trigger: e.trigger, model: reasoner.id })).catch(() => {})
    const run = runReasoner({ huntId: this.huntId, input: this.input, brandSlug: this.brandSlug, store: this.d.store, reasoner, me, agent, reservationId: r.id! }, c, e.trigger)
      .finally(() => { release(); this.reasoners.delete(run) })
    this.reasoners.add(run)
    return true
  }

  private async hasUnclassified() {
    const { caseIds } = await this.d.store.hunt(this.huntId).snapshot()
    const cases = await Promise.all(caseIds.map(id => this.d.store.kase(id).snapshot()))
    return cases.some(c => c.state === 'new')
  }

  private async hasTriaged() {
    const h = await this.d.store.hunt(this.huntId).snapshot()
    const remaining = h.input!.budgetUsd - h.spent
    if (remaining < this.d.verifyEstUsd) return false
    const { thresholds } = await this.d.store.brand(this.brandSlug).snapshot()
    const cases = await Promise.all(h.caseIds.map(id => this.d.store.kase(id).snapshot()))
    const earns = (score: number, deciderId: string) => score >= thresholdFor(thresholds[deciderId] ?? DEFAULT_THRESHOLD, this.input.precision)
    return cases.some(c => c.state === 'shortlisted' || (c.state === 'triaged' && earns(c.triage!.score, c.triage!.deciderId)))
  }

  private every(ms: number, fn: () => Promise<unknown>) {
    this.loops.push((async () => {
      while (!this.stopped) {
        try { await fn() } catch (err) { await this.d.store.hunt(this.huntId).log(`loop error: ${err}`, Date.now()).catch(() => {}) }
        await Bun.sleep(ms)
      }
    })())
  }

  /** The Case actor settles races, so a repeated decision changes nothing. */
  async decide(caseId: string, decision: 'approve' | 'reject', by: string) {
    const { store } = this.d
    const kase = store.kase(caseId)
    const r = await kase.decide(decision, by, Date.now())
    if (!r.changed) return r
    const c = await kase.snapshot()
    const hunt = store.hunt(this.huntId)
    await hunt.bump(decision === 'approve' ? 'approved' : 'rejected')
    await hunt.log(`${decision === 'approve' ? 'Approved, simulated submit only' : 'Rejected'}: ${c.hit!.url}`, Date.now())
    const brand = store.brand(this.brandSlug)
    await brand.addLabel({ caseId, url: c.hit!.url, decision, deciderId: c.verification?.deciderId ?? c.triage?.deciderId ?? 'unknown', score: c.verification?.score ?? 0, seller: c.hit!.seller })
    if (decision === 'reject' && c.hit!.lane) await brand.recordLaneOutcome(c.hit!.lane, { tries: 0, hits: -1, costUsd: 0 })
    // A runner rebuilt only to record a decision on a finished hunt never joined the bus.
    await this.human?.send(REVIEW_CHANNEL, encodeTag('DECISION', { caseId, decision })).catch(() => {})
    return r
  }

  /** Human controls travel the same channel the agents use. */
  async humanSay(to: string, text: string) { await this.human?.send(to, text) }
  channel = HUNT_CHANNEL

  async stop() {
    await this.launching
    this.stopped = true
    this.scouts.forEach(s => s.stop())
    this.unsub()
    await Promise.all(this.loops)
    await Promise.all(this.reasoners)
    await this.d.bus.close()
  }
}
