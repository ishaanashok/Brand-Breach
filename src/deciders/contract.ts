import type { Decider, Question } from '../core/types'

const QS: Question[] = [
  { type: 'predicate', name: 'impersonating', text: 'Does this impersonate the brand?' },
  { type: 'choice', name: 'surface', text: 'Which surface is this?', options: ['marketplace', 'social', 'other'] },
  { type: 'score', name: 'severity', text: 'How severe is this?', levels: ['low', 'medium', 'high'] },
]

export type ContractReport = { id: string; ok: boolean; problems: string[]; medianMs: number; p95Ms: number; labelAgreement: number }

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0
}

/** An adapter is enabled only if answers are valid, probabilities sum to about one, and latency is in bounds. */
export async function checkContract(d: Decider, items: { text: string; truth?: boolean }[], { maxP95Ms }: { maxP95Ms: number }): Promise<ContractReport> {
  const problems: string[] = []
  const lat: number[] = []
  let agreed = 0, labelled = 0
  for (const item of items) {
    const r = await d.decide({ text: item.text }, QS)
    lat.push(r.usage.latencyMs)
    for (const a of r.answers) {
      const sum = a.probabilities.reduce((t, x) => t + x.p, 0)
      if (a.probabilities.length && Math.abs(sum - 1) > 0.05) problems.push(`${a.name}: probabilities sum to ${sum.toFixed(2)}`)
      if (!(a.confidence >= 0 && a.confidence <= 1)) problems.push(`${a.name}: confidence ${a.confidence}`)
    }
    const imp = r.answers.find(a => a.name === 'impersonating')
    if (!imp) problems.push('missing answer: impersonating')
    else if (item.truth !== undefined) { labelled++; if (imp.value === item.truth) agreed++ }
  }
  const p95Ms = quantile(lat, 0.95)
  if (p95Ms > maxP95Ms) problems.push(`p95 ${p95Ms.toFixed(0)} ms over ${maxP95Ms} ms`)
  return { id: d.id, ok: problems.length === 0, problems, medianMs: quantile(lat, 0.5), p95Ms, labelAgreement: labelled ? agreed / labelled : 0 }
}
