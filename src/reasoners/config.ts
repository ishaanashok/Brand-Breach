import type { KbProposal } from '../core/kb'
import { KB_MODEL, nimClient } from '../harness/spiders'
import { glmKbReasoner } from './glm'
import { mockReasoner } from './mock'
import { openaiReasoner } from './openai'
import type { Reasoner } from './types'

type Env = Record<string, string | undefined>

export function reasonerFromConfig(env: Env, fixtures: Record<string, KbProposal[]> = {}): Reasoner {
  const mode = env.REASONER_MODE ?? (env.OPENAI_API_KEY ? 'openai' : env.NIM_API_KEY ? 'glm' : 'mock')
  if (mode === 'glm') {
    if (!env.NIM_API_KEY) throw new Error('REASONER_MODE=glm needs NIM_API_KEY')
    return glmKbReasoner({
      nim: nimClient({ apiKey: env.NIM_API_KEY, baseUrl: env.NIM_BASE_URL, model: env.NIM_KB_MODEL ?? KB_MODEL, timeoutMs: 45_000, retries: 1 }),
      fast: nimClient({ apiKey: env.NIM_API_KEY, baseUrl: env.NIM_BASE_URL, model: env.NIM_MODEL }),
    })
  }
  if (mode === 'mock') return mockReasoner({ fixtures, delayMs: 1200 })
  if (mode !== 'openai') throw new Error(`unknown REASONER_MODE ${mode}`)
  if (!env.OPENAI_API_KEY) throw new Error('REASONER_MODE=openai needs OPENAI_API_KEY')
  const num = (v?: string) => (v ? Number(v) : undefined)
  return openaiReasoner({
    apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, model: env.REASONER_MODEL,
    usdPerMInput: num(env.REASONER_USD_PER_M_INPUT), usdPerMOutput: num(env.REASONER_USD_PER_M_OUTPUT),
  })
}
