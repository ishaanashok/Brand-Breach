export type Surface = 'marketplace' | 'social' | 'channels' | 'domains' | 'video'
export const SURFACES: Surface[] = ['marketplace', 'social', 'channels', 'domains', 'video']

export type Lane = { source: Surface; strategy: string; query: string }
export const laneKey = (l: Pick<Lane, 'source' | 'strategy'>) => `${l.source}/${l.strategy}`

export type LeadKind = 'seller' | 'domain' | 'wallet' | 'channel'
export type Lead = { kind: LeadKind; value: string; note?: string }

export type Hit = {
  url: string
  surface: Surface
  title: string
  snippet: string
  seller?: string
  price?: number
  listPrice?: number
  leads?: Lead[]
  /** Richer text, standing in for sandbox capture on the tape. */
  evidenceText?: string
  /** Ground truth label on the synthetic tape, never read by the pipeline. */
  truth?: boolean
}

export type Question =
  | { type: 'predicate'; name: string; text: string }
  | { type: 'choice'; name: string; text: string; options: string[] }
  | { type: 'score'; name: string; text: string; levels: string[] }

export type ImageRef = { dataUrl: string; description?: string }
export type Evidence = { text: string; images?: ImageRef[] }

export type Answer = {
  name: string
  type: Question['type']
  value: string | boolean | number
  probabilities: { value: string | boolean; p: number }[]
  confidence: number
  refused?: boolean
}

export type DecideResult = {
  answers: Answer[]
  usage: { inputTokens: number; usd: number; latencyMs: number }
  deciderId: string
  visualEvidenceUnavailable?: boolean
}

export interface Decider {
  id: string
  caps: { images: boolean; maxQuestions: number; maxInputTokens: number }
  price: { usdPerMInput: number }
  decide(e: Evidence, qs: Question[], opts?: { timeoutMs: number }): Promise<DecideResult>
}

export type Precision = 'precision' | 'balanced' | 'recall'

export type HuntInput = {
  brand: string
  keywords: string[]
  officialDomains: string[]
  authorizedSellers: string[]
  budgetUsd: number
  precision: Precision
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** A machine method: pure, takes state and args, returns next state and a result. */
export type Step<S, R> = [S, R]
