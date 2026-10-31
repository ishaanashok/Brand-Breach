import type { Answer, Hit, Step } from '../types'

export type CaseStage = 'empty' | 'new' | 'skipped' | 'triaged' | 'undecided' | 'shortlisted' | 'cleared'
  | 'verified' | 'awaiting_approval' | 'approved' | 'rejected'

export type DecisionRecord = {
  answers: Answer[]
  deciderId: string
  usd: number
  latencyMs: number
  score: number
  confidence: number
  why: string
  visualEvidenceUnavailable?: boolean
  shadow?: { deciderId: string; agreed: boolean; latencyMs: number }
}
export type Verification = DecisionRecord & { verified: boolean; evidenceRefs?: string[] }

export type CaseState = {
  id: string
  version: number
  state: CaseStage
  brand: string
  huntId: string
  hit: Hit | null
  reporters: string[]
  triage: DecisionRecord | null
  verification: Verification | null
  notice: string | null
  approval: { decision: 'approve' | 'reject'; by: string; at: number; simulatedSubmit: boolean } | null
  skipReason: string | null
  recheck: { at: number; result: string } | null
  firstReportedAt: number
}

export const initialCase = (): CaseState => ({
  id: '', version: 0, state: 'empty', brand: '', huntId: '', hit: null, reporters: [], triage: null,
  verification: null, notice: null, approval: null, skipReason: null, recheck: null, firstReportedAt: 0,
})

const v = (s: CaseState, patch: Partial<CaseState>): CaseState => ({ ...s, ...patch, version: s.version + 1 })

export const kase = {
  report(s: CaseState, id: string, brand: string, huntId: string, hit: Hit, reporter: string, now: number): Step<CaseState, { first: boolean; state: CaseStage }> {
    if (s.state !== 'empty') {
      const reporters = s.reporters.includes(reporter) ? s.reporters : [...s.reporters, reporter]
      return [v(s, { reporters }), { first: false, state: s.state }]
    }
    return [v(s, { id, brand, huntId, hit, reporters: [reporter], state: 'new', firstReportedAt: now }), { first: true, state: 'new' }]
  },
  skip(s: CaseState, reason: string): Step<CaseState, null> {
    return s.state === 'new' ? [v(s, { state: 'skipped', skipReason: reason }), null] : [s, null]
  },
  setTriage(s: CaseState, t: DecisionRecord): Step<CaseState, null> {
    return s.state === 'new' ? [v(s, { triage: t, state: 'triaged' }), null] : [s, null]
  },
  markUndecided(s: CaseState, reason: string): Step<CaseState, null> {
    return [v(s, { state: 'undecided', skipReason: reason }), null]
  },
  shortlist(s: CaseState): Step<CaseState, boolean> {
    return s.state === 'triaged' ? [v(s, { state: 'shortlisted' }), true] : [s, false]
  },
  setVerification(s: CaseState, r: Verification): Step<CaseState, null> {
    if (s.state !== 'shortlisted') return [s, null]
    return [v(s, { verification: r, state: r.verified ? 'verified' : 'cleared' }), null]
  },
  draftNotice(s: CaseState, notice: string): Step<CaseState, null> {
    return s.state === 'verified' ? [v(s, { notice, state: 'awaiting_approval' }), null] : [s, null]
  },
  decide(s: CaseState, decision: 'approve' | 'reject', by: string, now: number): Step<CaseState, { changed: boolean; state: CaseStage }> {
    if (s.state !== 'awaiting_approval') return [s, { changed: false, state: s.state }]
    const state = decision === 'approve' ? 'approved' : 'rejected'
    // Nothing leaves this system: an approval only records a simulated submit.
    return [v(s, { state, approval: { decision, by, at: now, simulatedSubmit: decision === 'approve' } }), { changed: true, state }]
  },
  recheck(s: CaseState, result: string, now: number): Step<CaseState, null> {
    return [v(s, { recheck: { at: now, result } }), null]
  },
  snapshot(s: CaseState): Step<CaseState, CaseState> {
    return [s, s]
  },
}
