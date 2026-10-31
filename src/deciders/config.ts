import type { Decider } from '../core/types'
import { fallbackChain } from './fallback'
import { layaDecider } from './laya'
import { mockDecider } from './mock'
import { openaiDecider } from './openai'
import { shadowDecider, type ShadowLog } from './shadow'

type Env = Record<string, string | undefined>
type Hooks = { onFallback?: (from: string, error: string) => void; onShadow?: (l: ShadowLog) => void }

const TIMEOUT_MS = 1500

export function deciderFromConfig(env: Env, hooks: Hooks): { triage: Decider; verify: Decider; mode: string } {
  const mode = env.DECIDER_MODE ?? 'laya'
  const laya = () => layaDecider({ baseUrl: env.LAYA_URL })
  const openai = () => {
    if (!env.OPENAI_API_KEY) throw new Error(`DECIDER_MODE=${mode} needs OPENAI_API_KEY`)
    return openaiDecider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL })
  }
  const chain = (...ds: Decider[]) => fallbackChain(ds, { timeoutMs: TIMEOUT_MS, onFallback: hooks.onFallback })
  const log = hooks.onShadow ?? (() => {})

  switch (mode) {
    case 'mock': return { mode, triage: chain(mockDecider()), verify: chain(mockDecider()) }
    case 'laya': return { mode, triage: chain(laya(), mockDecider()), verify: chain(laya(), mockDecider()) }
    case 'target': return { mode, triage: chain(openai(), laya()), verify: chain(openai(), laya()) }
    case 'hybrid': return { mode, triage: chain(laya(), openai()), verify: chain(openai(), laya()) }
    case 'shadow': {
      const d = shadowDecider(openai(), laya(), log)
      return { mode, triage: d, verify: d }
    }
    default: throw new Error(`unknown DECIDER_MODE ${mode}`)
  }
}
