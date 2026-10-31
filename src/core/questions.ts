import type { Answer, Hit, Question } from './types'

export const triageQuestions = (brand: string): Question[] => [
  { type: 'predicate', name: 'impersonating', text: `Does this content impersonate ${brand} or sell counterfeit ${brand} goods?` },
  { type: 'predicate', name: 'scam', text: 'Does this content promote a scam or a fake giveaway?' },
  { type: 'choice', name: 'surface', text: 'Where does this content appear?', options: ['marketplace listing', 'social post', 'channel', 'website', 'video', 'other'] },
  { type: 'score', name: 'severity', text: 'How severe would the harm to customers be?', levels: ['low', 'medium', 'high'] },
]

export const verifyQuestions = (brand: string): Question[] => [
  { type: 'predicate', name: 'impersonating', text: `Given the fuller evidence, does this impersonate ${brand} or sell counterfeit ${brand} goods?` },
  { type: 'predicate', name: 'scam', text: 'Given the fuller evidence, does this promote a scam or a fake giveaway?' },
]

export const hitText = (h: Hit) =>
  [h.title, h.snippet, h.seller && `Seller: ${h.seller}`, h.price && `Price: ${h.price}`, h.url].filter(Boolean).join('\n')

const prob = (answers: Answer[], name: string) => {
  const a = answers.find(x => x.name === name)
  if (!a || a.refused) return 0
  return (a.probabilities.find(p => p.value === true)?.p) ?? (a.value === true ? a.confidence : 0)
}

/** Combines the predicates into one score, and says why in plain words for the dashboard. */
export function summarize(answers: Answer[]) {
  const imp = prob(answers, 'impersonating')
  const scam = prob(answers, 'scam')
  const score = Math.max(imp, scam)
  const sev = answers.find(a => a.name === 'severity')
  const severity = sev && !sev.refused ? 1 + Number(sev.value) : 1
  const used = answers.filter(a => a.name === 'impersonating' || a.name === 'scam')
  const confidence = used.length ? Math.min(...used.map(a => a.confidence)) : 0
  const parts = []
  if (imp >= 0.5) parts.push(`impersonation likely (${imp.toFixed(2)})`)
  if (scam >= 0.5) parts.push(`scam or giveaway language likely (${scam.toFixed(2)})`)
  const why = parts.length ? parts.join('; ') : `low signal (impersonation ${imp.toFixed(2)}, scam ${scam.toFixed(2)})`
  return { score, severity, confidence, why }
}
