import { canonicalUrl } from '../core/canonical'
import { caseId } from '../core/case-id'
import { kbEntities, matchKb } from '../core/kb'
import type { CaseState } from '../core/machines/case'
import type { SteerKind } from '../core/machines/hunt'
import { hitText, summarize, triageQuestions } from '../core/questions'
import { rulesCheck, type RuleContext } from '../core/rules'
import { encodeTag, parseTag } from '../core/tags'
import { laneKey, type Decider, type Hit, type HuntInput, type Lane, type Lead, type LeadKind, type Surface } from '../core/types'
import { HUNT_CHANNEL, type Bus, type Participant } from '../relay/types'
import type { Store } from '../store/types'
import { estimateTokens } from '../deciders/util'
import type { SearchResult, Source } from './source'

const LEAD_ROUTE: Record<LeadKind, Surface> = { seller: 'marketplace', domain: 'domains', wallet: 'channels', channel: 'channels' }
const TRIAGE_TIMEOUT_MS = 1500
// Only repeats twice running means the lane has nothing new, even if it still returns results.
const DRY_LIMIT = 2

export type ScoutDeps = {
  huntId: string; input: HuntInput; brandSlug: string; store: Store; bus: Bus
  source: Source; triage: Decider; delayMs: number
}

/** Stateless by design: all it needs after a crash is re-read from the Hunt actor. */
export class Scout {
  private me!: Participant
  private lane!: Lane
  private pendingSteer: { lane: Lane; reason: string; kind: SteerKind } | null = null
  private leads: Lead[] = []
  private stopped = false
  private unsub = () => {}
  private rules: RuleContext

  constructor(public name: Surface, private d: ScoutDeps, private initialLane: Lane) {
    this.rules = { officialDomains: d.input.officialDomains, authorizedSellers: d.input.authorizedSellers, whitelist: [] }
  }

  private get hunt() { return this.d.store.hunt(this.d.huntId) }
  private get brand() { return this.d.store.brand(this.d.brandSlug) }

  /** Separate from run() so every scout exists on the bus before anyone messages one. */
  async connect() {
    this.me = await this.d.bus.register(this.name)
    this.unsub = this.d.bus.onMessage(m => {
      if (m.to !== `@${this.name}`) return
      const parsed = parseTag(m.text)
      if (parsed?.tag === 'STEER') {
        this.pendingSteer = { lane: parsed.payload.lane, reason: parsed.payload.reason ?? 'steered', kind: parsed.payload.kind ?? 'manual' }
      } else if (parsed?.tag === 'LEAD') {
        this.leads.push(parsed.payload as Lead)
      }
    })
    this.lane = await this.hunt.registerScout(this.name, this.initialLane, Date.now())
    await this.me.send(HUNT_CHANNEL, `${this.name} online on ${laneKey(this.lane)}`)
  }

  run() { return this.loop() }

  stop() { this.stopped = true; this.unsub() }

  private async loop() {
    let exhausted = false
    let dry = 0
    while (!this.stopped) {
      const s = await this.hunt.snapshot()
      if (s.status === 'done' || s.status === 'budget_exhausted') break
      if (s.status === 'paused') { await Bun.sleep(this.d.delayMs); continue }

      if (this.pendingSteer) {
        const { lane, reason, kind } = this.pendingSteer
        this.pendingSteer = null
        this.lane = lane
        exhausted = false
        dry = 0
        await this.hunt.setLane(this.name, lane, reason, Date.now(), kind)
        await this.hunt.setScoutStatus(this.name, 'online', Date.now())
      }

      const lead = this.leads.shift()
      if (lead) {
        await this.iteration(() => this.d.source.followLead(lead, this.lane))
      } else if (exhausted) {
        await Bun.sleep(this.d.delayMs)
        continue
      } else {
        const r = await this.iteration(() => this.d.source.search(this.lane))
        dry = r && r.found > 0 && r.fresh === 0 ? dry + 1 : 0
        if (r && (r.failed || r.found === 0 || dry >= DRY_LIMIT)) {
          exhausted = true
          await this.hunt.setScoutStatus(this.name, `${r.failed ? 'blocked' : 'exhausted'}:${laneKey(this.lane)}`, Date.now())
        }
      }
      await Bun.sleep(this.d.delayMs)
    }
  }

  /** Reserve, search, triage, report. Returns what the search yielded, or null if it could not spend. */
  private async iteration(search: () => Promise<SearchResult>): Promise<{ found: number; fresh: number; failed?: boolean } | null> {
    const key = laneKey(this.lane)
    const r = await this.hunt.reserve(this.name, this.d.source.estUsd, Date.now())
    if (!r.ok) return null
    let result: SearchResult
    try {
      result = await search()
      await this.hunt.settle(r.id!, result.usd)
    } catch (err) {
      await this.hunt.settle(r.id!, 0)
      await this.hunt.log(`${this.name} search failed: ${String(err)}`, Date.now())
      return { found: 0, fresh: 0, failed: true }
    }
    await this.d.store.playbook().update(key, { tries: 1, hits: 0, costUsd: result.usd })
    await this.brand.recordLaneOutcome(key, { tries: 1, hits: 0, costUsd: result.usd })
    const b = await this.brand.snapshot()
    this.rules.whitelist = b.whitelist
    this.rules.kb = kbEntities(b)
    const firsts = await Promise.all(result.hits.map(h => this.handleHit({ ...h, lane: key })))
    return { found: result.hits.length, fresh: firsts.filter(Boolean).length }
  }

  private async handleHit(hit: Hit): Promise<boolean> {
    const id = caseId(this.d.brandSlug, hit.url)
    const url = canonicalUrl(hit.url)
    await this.hunt.bump('seen')
    const { first } = await this.d.store.kase(id).report(id, this.d.brandSlug, this.d.huntId, { ...hit, url }, this.name, Date.now())
    if (!first) { await this.hunt.bump('duplicates'); return false }
    await this.hunt.addCase(id)
    await this.me.send(HUNT_CHANNEL, encodeTag('NEW', { caseId: id, url, lane: hit.lane })).catch(() => {})
    if (hit.seller) await this.brand.addEdges([{ from: `listing:${url}`, to: `seller:${hit.seller}`, kind: 'sold_by' }])
    await this.assess(id, hit, url)
    return true
  }

  /** A crash can land between reporting a case and triaging it, and a later report is only a duplicate. */
  async recover(c: CaseState) {
    const b = await this.brand.snapshot()
    this.rules.whitelist = b.whitelist
    this.rules.kb = kbEntities(b)
    await this.assess(c.id, c.hit!, c.hit!.url)
  }

  private async assess(id: string, hit: Hit, url: string) {
    const rule = rulesCheck(hit, this.rules)
    if (rule.skip) {
      await this.d.store.kase(id).skip(rule.skip)
      await this.hunt.bump('skipped')
      return
    }
    await this.triage(id, hit, rule.priceFlag)
    for (const lead of hit.leads ?? []) await this.shareLead(lead, url)
  }

  private async triage(id: string, hit: Hit, priceFlag: boolean) {
    const text = hitText(hit) + (priceFlag ? '\nPrice is far below the usual price.' : '')
    const est = (estimateTokens(text) / 1e6) * this.d.triage.price.usdPerMInput
    const r = await this.hunt.reserve(this.name, est, Date.now())
    if (!r.ok) return
    try {
      const res = await this.d.triage.decide({ text }, triageQuestions(this.d.input.brand), { timeoutMs: TRIAGE_TIMEOUT_MS })
      await this.hunt.settle(r.id!, res.usage.usd)
      const sum = summarize(res.answers)
      await this.d.store.kase(id).setTriage({
        answers: res.answers, deciderId: res.deciderId, usd: res.usage.usd, latencyMs: res.usage.latencyMs,
        score: sum.score, confidence: sum.confidence, why: sum.why, visualEvidenceUnavailable: res.visualEvidenceUnavailable,
      })
      await this.hunt.bump('triaged')
      // Provisional reward; verification and the human correct it later.
      const key = hit.lane!
      await this.brand.recordLaneOutcome(key, { tries: 0, hits: sum.score, costUsd: res.usage.usd })
      await this.d.store.playbook().update(key, { tries: 0, hits: sum.score, costUsd: res.usage.usd })
      await this.brand.markSeen(canonicalUrl(hit.url), { score: sum.score, state: 'triaged' })
    } catch (err) {
      await this.hunt.settle(r.id!, 0)
      await this.d.store.kase(id).markUndecided(String(err))
      await this.hunt.bump('undecided')
    }
  }

  private async shareLead(lead: Lead, fromUrl: string) {
    // Chasing what is already known to be real only spends money.
    if (lead.kind === 'seller' && matchKb({ url: fromUrl, seller: lead.value }, (this.rules.kb ?? []).filter(e => e.kind === 'seller'))) return
    const target = LEAD_ROUTE[lead.kind]
    await this.brand.addEdges([{ from: `listing:${fromUrl}`, to: `${lead.kind}:${lead.value}`, kind: 'lead' }])
    if (target === this.name) { this.leads.push(lead); return }
    // A lost hand-off costs a follow-up search, never the scout.
    await this.me.send(`@${target}`, encodeTag('LEAD', lead)).catch(err => this.hunt.log(`lead to ${target} failed: ${err}`, Date.now()))
  }
}
