import { draftNotice } from '../core/notice'
import { rankShortlist, thresholdFor } from '../core/policy'
import { hitText, summarize, verifyQuestions } from '../core/questions'
import { encodeTag } from '../core/tags'
import type { CaseState } from '../core/machines/case'
import type { Decider, HuntInput } from '../core/types'
import { REVIEW_CHANNEL, type Participant } from '../relay/types'
import type { Store } from '../store/types'

const VERIFIED_AT = 0.5
const PARALLEL = 8 // The shared decider slots still limit a local classifier.

export type VerifierDeps = {
  huntId: string; input: HuntInput; brandSlug: string; store: Store; me: Participant
  verify: Decider; estUsd: number
  capture?: (url: string) => Promise<string | undefined>
}

/** Server-side stage 2: only shortlisted cases earn richer evidence and a second decision. */
export async function verifyTick(d: VerifierDeps): Promise<number> {
  const hunt = d.store.hunt(d.huntId)
  const brand = d.store.brand(d.brandSlug)
  const h = await hunt.snapshot()
  const cases = await d.store.cases(h.caseIds)
  const triaged = cases.filter(c => c.state === 'triaged' && c.triage)
  if (!triaged.length) return 0

  const byId = new Map(triaged.map(c => [c.id, c]))
  const groups = new Map<string, CaseState[]>()
  for (const c of triaged) groups.set(c.triage!.deciderId, [...(groups.get(c.triage!.deciderId) ?? []), c])
  let done = 0
  for (const [deciderId, group] of groups) {
    const threshold = thresholdFor(await brand.getThreshold(deciderId), d.input.precision)
    const remaining = h.input!.budgetUsd - h.spent
    const pick = rankShortlist(
      group.map(c => ({ id: c.id, p: c.triage!.score, severity: 1 + (c.triage!.score > 0.8 ? 1 : 0), estCostUsd: d.estUsd })),
      { threshold, remainingUsd: remaining },
    )
    // Best first: each worker takes the next page, and the Hunt actor keeps the budget safe.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(PARALLEL, pick.length) }, async () => {
      while (next < pick.length) {
        if (await verifyOne(d, byId.get(pick[next++]!.id)!)) done++
      }
    }))
  }
  return done
}

async function verifyOne(d: VerifierDeps, c: CaseState): Promise<boolean> {
  const hunt = d.store.hunt(d.huntId)
  const brand = d.store.brand(d.brandSlug)
  const kase = d.store.kase(c.id)
  const r = await hunt.reserve('verifier', d.estUsd, Date.now())
  if (!r.ok) return false
  if (!(await kase.shortlist())) { await hunt.settle(r.id!, 0); return false }
  await hunt.bump('shortlisted')
  let hit = c.hit!
  // Only pages that earned a closer look get fetched.
  if (!hit.evidenceText && d.capture) {
    const evidenceText = await d.capture(hit.url)
    if (evidenceText) {
      await kase.addEvidence(evidenceText)
      hit = { ...hit, evidenceText }
    }
  }
  const text = [hitText(hit), hit.evidenceText && `Captured evidence: ${hit.evidenceText}`].filter(Boolean).join('\n')
  try {
    const res = await d.verify.decide({ text }, verifyQuestions(d.input.brand), { timeoutMs: 30_000 })
    // Simulated capture cost stands in for the sandbox until one is connected.
    const usd = Math.max(res.usage.usd, d.estUsd)
    await hunt.settle(r.id!, usd)
    const sum = summarize(res.answers)
    const verified = sum.score >= VERIFIED_AT
    await kase.setVerification({
      answers: res.answers, deciderId: res.deciderId, usd, latencyMs: res.usage.latencyMs, score: sum.score,
      confidence: sum.confidence, why: sum.why, verified, visualEvidenceUnavailable: res.visualEvidenceUnavailable,
    })
    const key = hit.lane
    if (key) await brand.recordLaneOutcome(key, { tries: 0, hits: (verified ? 1 : 0) - c.triage!.score, costUsd: usd })
    await brand.markSeen(hit.url, { score: sum.score, state: verified ? 'verified' : 'cleared' }, d.huntId, Date.now())
    if (verified) {
      await hunt.bump('verified')
      await hunt.markFirstVerified(Date.now())
      await kase.draftNotice(draftNotice({ brand: d.input.brand, url: hit.url, surface: hit.surface, why: sum.why, score: sum.score }))
      await d.me.send(REVIEW_CHANNEL, encodeTag('REVIEW', { caseId: c.id }))
    }
    return verified
  } catch (err) {
    await hunt.settle(r.id!, 0)
    await kase.markUndecided(String(err))
    await hunt.bump('undecided')
    return false
  }
}
