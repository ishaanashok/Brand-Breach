import { draftNotice } from '../core/notice'
import { earnsReading, rankShortlist, thresholdFor } from '../core/policy'
import { LIKELY_AT, hasReadableEvidence, hitText, summarize, usableText, verifyQuestions } from '../core/questions'
import { encodeTag } from '../core/tags'
import type { CaseState } from '../core/machines/case'
import type { Decider, HuntInput } from '../core/types'
import type { Capture } from './source'
import { REVIEW_CHANNEL, type Participant } from '../relay/types'
import type { Store } from '../store/types'

const NO_TEXT = 'The page shows no text to a reader, usually because it needs a browser or shows a bot check'
const PARALLEL = 8 // The shared decider slots still limit a local classifier.

export type VerifierDeps = {
  huntId: string; input: HuntInput; brandSlug: string; store: Store; me: Participant
  verify: Decider; estUsd: number
  capture?: (url: string) => Promise<Capture>
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
      group.map(c => ({ id: c.id, p: earnsReading(c.triage!.score, threshold, hasReadableEvidence(c.hit!)) ? Math.max(c.triage!.score, threshold) : c.triage!.score, severity: 1 + (c.triage!.score > 0.8 ? 1 : 0), estCostUsd: d.estUsd })),
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
  let problem: string | undefined
  // Only pages that earned a closer look get fetched.
  if (!usableText(hit.evidenceText) && d.capture) {
    const got = await d.capture(hit.url)
    problem = got.problem
    if (usableText(got.text)) {
      await kase.addEvidence(got.text!)
      hit = { ...hit, evidenceText: got.text! }
    }
  }
  // Asking about a bare URL only buys a coin flip, so this costs nothing and claims nothing.
  if (!hasReadableEvidence(hit)) {
    await hunt.settle(r.id!, 0)
    await kase.markUnreadable(problem ?? NO_TEXT)
    await hunt.bump('unreadable')
    await brand.markSeen(hit.url, { score: 0, state: 'unreadable' }, d.huntId, Date.now())
    return false
  }
  const text = [hitText(hit), usableText(hit.evidenceText) && `Captured evidence: ${hit.evidenceText}`].filter(Boolean).join('\n')
  try {
    const res = await d.verify.decide({ text }, verifyQuestions(d.input.brand), { timeoutMs: 30_000 })
    // Simulated capture cost stands in for the sandbox until one is connected.
    const usd = Math.max(res.usage.usd, d.estUsd)
    await hunt.settle(r.id!, usd)
    const sum = summarize(res.answers)
    // Search results can be enough to flag a page, but a person should know nobody read it.
    if (!usableText(hit.evidenceText) && !sum.discusses) sum.why += '. Based on the search result only: the page itself could not be read'
    const verified = !sum.discusses && sum.score >= LIKELY_AT
    await kase.setVerification({
      answers: res.answers, deciderId: res.deciderId, usd, latencyMs: res.usage.latencyMs, score: sum.score,
      confidence: sum.confidence, why: sum.why, verified, visualEvidenceUnavailable: res.visualEvidenceUnavailable,
    })
    const key = hit.lane
    if (key) await brand.recordLaneOutcome(key, { tries: 0, hits: (verified ? 1 : 0) - c.triage!.score, costUsd: usd })
    await brand.markSeen(hit.url, { score: sum.score, state: verified ? 'verified' : 'cleared' }, d.huntId, Date.now())
    if (!verified) await hunt.bump('cleared')
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
