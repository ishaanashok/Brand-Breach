import { fromProposals, kbEntities } from '../core/kb'
import { encodeTag } from '../core/tags'
import type { HuntInput } from '../core/types'
import { HUNT_CHANNEL, type Participant } from '../relay/types'
import type { Reasoner } from '../reasoners/types'
import type { Store } from '../store/types'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Asks the reasoning model what genuinely belongs to the brand, before any scout searches.
 * Built once per brand and kept, so later hunts start knowing it for free.
 * A failure costs only the extra knowledge: operator entries still apply.
 */
export async function ensureKb(d: { huntId: string; input: HuntInput; brandSlug: string; store: Store; reasoner: Reasoner; me: Participant }) {
  const hunt = d.store.hunt(d.huntId)
  const brand = d.store.brand(d.brandSlug)
  const now = Date.now()
  const b = await brand.snapshot()
  if (b.kb?.builtAt && b.kb.builtBy === d.reasoner.id && now - b.kb.builtAt < MAX_AGE_MS) {
    await hunt.log(`Knowledge base reused: ${kbEntities(b).length} entities, no cost`, now)
    return
  }
  const r = await hunt.reserve('kb-builder', d.reasoner.kbEstUsd, now)
  if (!r.ok) { await hunt.log('Knowledge base not built: no budget for it', now); return }
  try {
    const { proposals, usage } = await d.reasoner.buildKb({
      brand: d.input.brand, keywords: d.input.keywords, officialDomains: d.input.officialDomains, authorizedSellers: d.input.authorizedSellers,
    })
    await hunt.settle(r.id!, usage.usd)
    const entities = fromProposals(proposals)
    await brand.setKb(entities, d.reasoner.id, Date.now())
    const verified = entities.filter(e => e.status === 'verified').length
    await hunt.log(`Knowledge base built by ${d.reasoner.id}: ${verified} verified, ${entities.length - verified} candidates, ${proposals.length - entities.length} refused`, Date.now())
    await d.me.send(HUNT_CHANNEL, encodeTag('KB', { verified, candidates: entities.length - verified, by: d.reasoner.id })).catch(() => {})
  } catch (err) {
    await hunt.settle(r.id!, 0)
    await hunt.log(`Knowledge base build failed, using operator entries only: ${err}`, Date.now())
  }
}
