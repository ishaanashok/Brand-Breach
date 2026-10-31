import { rankLanes } from '../core/lanes'
import { DEFAULT_THRESHOLD } from '../core/machines/brand'
import { thresholdFor } from '../core/policy'
import { encodeTag, parseTag } from '../core/tags'
import { SURFACES, laneKey, slug, type Decider, type HuntInput, type Lane, type Surface } from '../core/types'
import { HUNT_CHANNEL, REVIEW_CHANNEL, type Bus, type Participant } from '../relay/types'
import type { Store } from '../store/types'
import { createOrchestrator } from './orchestrator'
import { Scout } from './scout'
import type { Source } from './source'
import { verifyTick } from './verifier'

export type Timing = { scoutDelayMs: number; tickMs: number; cooldownMs: number; verifyMs: number }
export const DEMO_TIMING: Timing = { scoutDelayMs: 1500, tickMs: 8000, cooldownMs: 20_000, verifyMs: 2000 }

export type RunnerDeps = {
  store: Store; bus: Bus; source: Source; triage: Decider; verify: Decider
  verifyEstUsd: number; timing: Timing
}

/** Hosts one hunt's scouts, orchestrator and verifier. All of it is rebuilt from actors on resume. */
export class HuntRunner {
  private scouts: Scout[] = []
  private stopped = false
  private loops: Promise<unknown>[] = []
  private unsub = () => {}
  private human!: Participant
  private input!: HuntInput
  private brandSlug = ''

  constructor(public huntId: string, private d: RunnerDeps) {}

  async start(input: HuntInput) {
    const { store } = this.d
    await store.playbook().registerHunt(this.huntId)
    await store.hunt(this.huntId).init(this.huntId, input, Date.now(), this.d.triage.id)
    await store.brand(slug(input.brand)).configure(slug(input.brand), input.officialDomains, input.authorizedSellers)
    await this.launch(input, true)
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

    const lanes = await this.initialLanes()
    const common = { huntId: this.huntId, input, brandSlug: this.brandSlug, store, bus, source: this.d.source, triage: this.d.triage, delayMs: this.d.timing.scoutDelayMs }
    this.scouts = SURFACES.map(s => new Scout(s, common, lanes[s]))
    for (const s of this.scouts) {
      this.loops.push(s.start().catch(err => store.hunt(this.huntId).log(`${s.name} crashed: ${err}`, Date.now())))
    }
    // Scouts take their lane from the Hunt actor, so ASSIGN only announces it. A resume stays silent.
    if (announce) for (const s of SURFACES) await orchestratorMe.send(`@${s}`, encodeTag('ASSIGN', { lane: lanes[s], budgetSliceUsd: input.budgetUsd / SURFACES.length }))

    const orch = createOrchestrator({ huntId: this.huntId, input, brandSlug: this.brandSlug, store, me: orchestratorMe, lanes: this.lanesFor, cooldownMs: this.d.timing.cooldownMs })
    this.every(this.d.timing.tickMs, () => orch.tick())
    this.every(this.d.timing.verifyMs, async () => {
      const n = await verifyTick({ huntId: this.huntId, input, brandSlug: this.brandSlug, store, me: verifierMe, verify: this.d.verify, estUsd: this.d.verifyEstUsd })
      if (n === 0 && await orch.finished() && !(await this.hasTriaged())) {
        const h = await store.hunt(this.huntId).snapshot()
        if (h.status === 'running') await store.hunt(this.huntId).setStatus('done')
      }
    })
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
    await this.human.send(REVIEW_CHANNEL, encodeTag('DECISION', { caseId, decision })).catch(() => {})
    return r
  }

  /** Human controls travel the same channel the agents use. */
  async humanSay(to: string, text: string) { await this.human.send(to, text) }
  channel = HUNT_CHANNEL

  async stop() {
    this.stopped = true
    this.scouts.forEach(s => s.stop())
    this.unsub()
    await Promise.all(this.loops)
    await this.d.bus.close()
  }
}
