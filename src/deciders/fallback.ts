import type { DecideResult, Decider } from '../core/types'

type Opts = { timeoutMs: number; onFallback?: (from: string, error: string) => void }

export function fallbackChain(chain: Decider[], { timeoutMs, onFallback }: Opts): Decider {
  const head = chain[0]!
  return {
    id: `fallback(${chain.map(d => d.id).join('>')})`,
    caps: head.caps,
    price: { usdPerMInput: Math.max(...chain.map(d => d.price.usdPerMInput)) },
    async decide(e, qs, opts): Promise<DecideResult> {
      const ms = opts?.timeoutMs ?? timeoutMs
      const errors: string[] = []
      for (const d of chain) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          // A race guards against adapters that ignore their abort signal.
          return await Promise.race([
            d.decide(e, qs, { timeoutMs: ms }),
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms) }),
          ])
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${d.id}: ${msg}`)
          if (d !== chain.at(-1)) onFallback?.(d.id, msg)
        } finally {
          clearTimeout(timer)
        }
      }
      throw new Error(`all deciders failed: ${errors.join('; ')}`)
    },
  }
}
