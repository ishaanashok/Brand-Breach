import type { Answer, Decider } from '../core/types'

export type ShadowLog = { primary: string; shadow: string; agreed: boolean; primaryMs: number; shadowMs: number }

const agree = (a: Answer[], b: Answer[]) =>
  a.every(x => {
    const y = b.find(o => o.name === x.name)
    if (!y) return false
    return x.type === 'score' ? Math.abs(Number(x.value) - Number(y.value)) < 1 : x.value === y.value
  })

/** The primary serves the call; the shadow sees the same input and only logs. */
export function shadowDecider(primary: Decider, shadow: Decider, log: (l: ShadowLog) => void): Decider {
  return {
    ...primary,
    id: `shadow(${primary.id}|${shadow.id})`,
    async decide(e, qs, opts) {
      const r = await primary.decide(e, qs, opts)
      shadow.decide(e, qs, opts).then(
        s => log({ primary: r.deciderId, shadow: s.deciderId, agreed: agree(r.answers, s.answers), primaryMs: r.usage.latencyMs, shadowMs: s.usage.latencyMs }),
        () => {},
      )
      return r
    },
  }
}
