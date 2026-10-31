import type { EscalationTrigger } from '../core/escalate'
import { kbEntities, resembles } from '../core/kb'
import { draftNotice } from '../core/notice'
import { encodeTag } from '../core/tags'
import type { CaseState } from '../core/machines/case'
import type { HuntInput } from '../core/types'
import { REVIEW_CHANNEL, type Participant } from '../relay/types'
import type { Reasoner } from '../reasoners/types'
import type { Store } from '../store/types'

export type ReasonerAgentDeps = {
  huntId: string; input: HuntInput; brandSlug: string; store: Store; reasoner: Reasoner
  me: Participant; agent: string; reservationId: string
}

const notesOf = (c: CaseState) =>
  [c.triage && `triage ${c.triage.score.toFixed(2)}: ${c.triage.why}`, c.verification && `verification ${c.verification.score.toFixed(2)}: ${c.verification.why}`, c.skipReason && `failed: ${c.skipReason}`]
    .filter(Boolean).join('; ') || 'no decision available'

/** A short-lived agent: one case, one verdict, then it is gone. */
export async function runReasoner(d: ReasonerAgentDeps, c: CaseState, trigger: EscalationTrigger) {
  const hunt = d.store.hunt(d.huntId)
  const brand = d.store.brand(d.brandSlug)
  const kase = d.store.kase(c.id)
  const hit = c.hit!
  try {
    const known = kbEntities(await brand.snapshot())
    const res = await d.reasoner.assess({
      brand: d.input.brand, hit, trigger, deciderNotes: notesOf(c),
      verifiedEntities: known.filter(e => e.status === 'verified').map(e => `${e.kind} ${e.value}`),
      resembles: resembles(hit.url, known)?.value,
    })
    await hunt.settle(d.reservationId, res.usage.usd)
    const out = await kase.setReasoning({
      reasonerId: d.reasoner.id, verdict: res.verdict, confidence: res.confidence, reasoning: res.reasoning, usd: res.usage.usd, latencyMs: res.usage.latencyMs,
    })
    await hunt.bump('reasoned')
    if (out.newlyVerified) {
      await hunt.bump('verified')
      await hunt.markFirstVerified(Date.now())
      await kase.draftNotice(draftNotice({ brand: d.input.brand, url: hit.url, surface: hit.surface, why: res.reasoning, score: res.confidence }))
      await d.me.send(REVIEW_CHANNEL, encodeTag('REVIEW', { caseId: c.id })).catch(() => {})
      if (hit.lane) await brand.recordLaneOutcome(hit.lane, { tries: 0, hits: 1 - (c.triage?.score ?? 0), costUsd: res.usage.usd })
    }
    if (out.retracted) {
      await hunt.bump('verified', -1)
      await hunt.bump('cleared')
      if (hit.lane) await brand.recordLaneOutcome(hit.lane, { tries: 0, hits: -1, costUsd: res.usage.usd })
    }
    await brand.markSeen(hit.url, { score: res.confidence, state: out.state })
    const outcome = `${res.verdict} (${res.confidence.toFixed(2)})`
    await hunt.finishSpawn(d.agent, c.id, outcome, Date.now())
    await d.me.send(REVIEW_CHANNEL, encodeTag('VERDICT', { caseId: c.id, verdict: res.verdict, confidence: res.confidence, by: d.reasoner.id })).catch(() => {})
  } catch (err) {
    await hunt.settle(d.reservationId, 0)
    await kase.failReasoning(String(err))
    await hunt.finishSpawn(d.agent, c.id, 'failed', Date.now())
    await hunt.log(`${d.agent} failed on ${hit.url}: ${err}`, Date.now())
  }
}
