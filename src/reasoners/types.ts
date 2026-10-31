import type { KbProposal } from '../core/kb'
import type { ReasonerVerdict } from '../core/machines/case'
import type { Hit } from '../core/types'

export type ReasonerUsage = { usd: number; latencyMs: number }
export type KbRequest = { brand: string; keywords: string[]; officialDomains: string[]; authorizedSellers: string[] }
export type AssessRequest = {
  brand: string; hit: Hit; trigger: string
  /** What the deciders said, and what is known to be real, so the reasoner can weigh both. */
  deciderNotes: string; verifiedEntities: string[]; resembles?: string
}
export type Assessment = { verdict: ReasonerVerdict; confidence: number; reasoning: string; usage: ReasonerUsage }

/** A slow, costly model the orchestrator uses sparingly, where a quick decision cannot settle it. */
export interface Reasoner {
  id: string
  /** Only builds the knowledge base. Never called in to judge a case. */
  kbOnly?: boolean
  /** Upper bounds reserved against the budget before each call. */
  kbEstUsd: number
  assessEstUsd: number
  buildKb(req: KbRequest): Promise<{ proposals: KbProposal[]; usage: ReasonerUsage }>
  assess(req: AssessRequest): Promise<Assessment>
}
