import type { KbProposal } from '../core/kb'
import { mockReasoner } from './mock'
import { openaiReasoner } from './openai'
import type { Reasoner } from './types'

type Env = Record<string, string | undefined>

export function reasonerFromConfig(env: Env, fixtures: Record<string, KbProposal[]> = {}): Reasoner {
  const mode = env.REASONER_MODE ?? (env.OPENAI_API_KEY ? 'openai' : 'mock')
  if (mode === 'mock') return mockReasoner({ fixtures, delayMs: 1200 })
  if (mode !== 'openai') throw new Error(`unknown REASONER_MODE ${mode}`)
  if (!env.OPENAI_API_KEY) throw new Error('REASONER_MODE=openai needs OPENAI_API_KEY')
  const num = (v?: string) => (v ? Number(v) : undefined)
  return openaiReasoner({
    apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, model: env.REASONER_MODEL,
    usdPerMInput: num(env.REASONER_USD_PER_M_INPUT), usdPerMOutput: num(env.REASONER_USD_PER_M_OUTPUT),
  })
}
