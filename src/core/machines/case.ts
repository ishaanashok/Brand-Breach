import type { Answer, Hit, Step } from '../types.js'

export type CaseStage = 'empty' | 'new' | 'skipped' | 'triaged' | 'undecided' | 'shortlisted' | 'cleared' | 'unreadable'
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

export type ReasonerVerdict = 'infringing' | 'legitimate' | 'unsure'
export type Reasoning = {
  status: 'running' | 'done' | 'failed'
  agent: string
  trigger: 'undecided' | 'unsure' | 'top'
  at: number
  reasonerId?: string
  verdict?: ReasonerVerdict
  confidence?: number
  reasoning?: string
  usd?: number
  latencyMs?: number
  error?: string
  /** The verdict contradicts the decider, so the person reviewing should see both. */
  disagrees?: boolean
}

export const REASONER_ACT_AT = 0.7

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
  reasoning: Reasoning | null
  skipReason: string | null
  recheck: { at: number; result: string } | null
  firstReportedAt: number
}

export const initialCase = (): CaseState => ({
  id: '', version: 0, state: 'empty', brand: '', huntId: '', hit: null, reporters: [], triage: null,
  verification: null, reasoning: null, notice: null, approval: null, skipReason: null, recheck: null, firstReportedAt: 0,
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
  /** Not a takedown target, with the reason a person sees under "Not flagged". */
  clear(s: CaseState, reason: string): Step<CaseState, null> {
    return ['new', 'triaged', 'shortlisted'].includes(s.state) ? [v(s, { state: 'cleared', skipReason: reason }), null] : [s, null]
  },
  /** Nobody read the page, so no score it has means anything. */
  markUnreadable(s: CaseState, reason: string): Step<CaseState, null> {
    return s.state === 'shortlisted' ? [v(s, { state: 'unreadable', skipReason: reason }), null] : [s, null]
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
  addEvidence(s: CaseState, evidenceText: string): Step<CaseState, null> {
    return s.hit ? [v(s, { hit: { ...s.hit, evidenceText } }), null] : [s, null]
  },
  setVerification(s: CaseState, r: Verification): Step<CaseState, null> {
    if (s.state !== 'shortlisted') return [s, null]
    return [v(s, { verification: r, state: r.verified ? 'verified' : 'cleared', skipReason: r.verified ? null : r.why }), null]
  },
  /** One reasoner per case. A claim whose agent died goes stale and can be taken over. */
  claimReasoning(s: CaseState, agent: string, trigger: Reasoning['trigger'], now: number, staleMs: number): Step<CaseState, boolean> {
    const r = s.reasoning
    if (r && !(r.status === 'running' && now - r.at > staleMs)) return [s, false]
    return [v(s, { reasoning: { status: 'running', agent, trigger, at: now } }), true]
  },
  failReasoning(s: CaseState, error: string): Step<CaseState, null> {
    return s.reasoning ? [v(s, { reasoning: { ...s.reasoning, status: 'failed', error } }), null] : [s, null]
  },
  /**
   * A confident verdict can settle a case nobody has decided, send one to a person, or clear one waiting for a person.
   * A person's decision is final, and a verdict against an earlier clearance shows as a disagreement.
   */
  setReasoning(s: CaseState, r: Pick<Reasoning, 'reasonerId' | 'verdict' | 'confidence' | 'reasoning' | 'usd' | 'latencyMs'>): Step<CaseState, { state: CaseStage; newlyVerified: boolean; retracted: boolean }> {
    if (!s.reasoning) return [s, { state: s.state, newlyVerified: false, retracted: false }]
    const sure = (r.confidence ?? 0) >= REASONER_ACT_AT
    const open = s.state === 'undecided' || s.state === 'triaged'
    let state = s.state
    if (sure && r.verdict === 'infringing' && (open || s.state === 'cleared')) state = 'verified'
    const retracted = sure && r.verdict === 'legitimate' && (s.state === 'awaiting_approval' || s.state === 'verified')
    if (sure && r.verdict === 'legitimate' && (open || retracted)) state = 'cleared'
    const disagrees = sure && r.verdict === 'infringing' && s.state === 'cleared'
    const skipReason = state === 'cleared' && s.state !== 'cleared' ? `A second opinion found this legitimate: ${r.reasoning ?? 'no reason given'}` : s.skipReason
    return [v(s, { state, skipReason, reasoning: { ...s.reasoning, ...r, status: 'done', disagrees } }), { state, newlyVerified: state === 'verified' && s.state !== 'verified', retracted }]
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
