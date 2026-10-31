import type { CaseState } from './machines/case.js'

export type EscalationTrigger = 'undecided' | 'unsure' | 'top'
export type Escalation = { caseId: string; trigger: EscalationTrigger }

const UNSURE_LOW = 0.35
const UNSURE_HIGH = 0.65
const LOW_CONFIDENCE = 0.5
export const TOP_PER_HUNT = 2
export const REASONER_STALE_MS = 120_000

const inBand = (x: number) => x >= UNSURE_LOW && x <= UNSURE_HIGH

function isUnsure(c: CaseState, threshold: (c: CaseState) => number) {
  if (c.state === 'triaged') {
    // The verifier takes anything over the bar, so only what it will leave behind is escalated.
    return !!c.triage && c.triage.score < threshold(c) && inBand(c.triage.score)
  }
  if (c.state !== 'cleared' && c.state !== 'awaiting_approval') return false
  return !!c.verification && (inBand(c.verification.score) || c.verification.confidence < LOW_CONFIDENCE)
}

/**
 * Which cases the orchestrator should hand to a reasoning agent, most needed first:
 * decisions that failed outright, then unsure ones, then the top few headed to a person.
 */
export function pickEscalations(cases: CaseState[], o: { slots: number; now: number; threshold: (c: CaseState) => number }): Escalation[] {
  if (o.slots <= 0) return []
  const open = cases.filter(c => c.hit && (!c.reasoning || (c.reasoning.status === 'running' && o.now - c.reasoning.at > REASONER_STALE_MS)))
  const byScore = (a: CaseState, b: CaseState) => ((b.verification ?? b.triage)?.score ?? 0) - ((a.verification ?? a.triage)?.score ?? 0)
  const taken = new Set<string>()
  const out: Escalation[] = []
  const add = (list: CaseState[], trigger: EscalationTrigger) => {
    for (const c of list) if (!taken.has(c.id)) { taken.add(c.id); out.push({ caseId: c.id, trigger }) }
  }
  add(open.filter(c => c.state === 'undecided'), 'undecided')
  add(open.filter(c => isUnsure(c, o.threshold)).sort(byScore), 'unsure')
  const topUsed = cases.filter(c => c.reasoning?.trigger === 'top').length
  add(open.filter(c => c.state === 'awaiting_approval').sort(byScore).slice(0, Math.max(0, TOP_PER_HUNT - topUsed)), 'top')
  return out.slice(0, o.slots)
}
