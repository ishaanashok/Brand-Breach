import type { Answer, Hit, Question } from './types'

const DISCUSSES = 'Does this page warn about, report on or discuss scams, fakes or counterfeits, for example as a news story, security blog, scam checker, forum thread, research paper or court record, rather than commit one itself?'

export const triageQuestions = (brand: string): Question[] => [
  { type: 'predicate', name: 'impersonating', text: `Does this content impersonate ${brand} or sell counterfeit ${brand} goods?` },
  { type: 'predicate', name: 'scam', text: 'Does this content promote a scam or a fake giveaway?' },
  { type: 'choice', name: 'surface', text: 'Where does this content appear?', options: ['marketplace listing', 'social post', 'channel', 'website', 'video', 'other'] },
  { type: 'predicate', name: 'discusses_scam', text: DISCUSSES },
  { type: 'score', name: 'severity', text: 'How severe would the harm to customers be?', levels: ['low', 'medium', 'high'] },
]

export const verifyQuestions = (brand: string): Question[] => [
  { type: 'predicate', name: 'impersonating', text: `Given the fuller evidence, does this impersonate ${brand} or sell counterfeit ${brand} goods?` },
  { type: 'predicate', name: 'scam', text: 'Given the fuller evidence, does this promote a scam or a fake giveaway?' },
  { type: 'predicate', name: 'discusses_scam', text: DISCUSSES },
]

export const hitText = (h: Hit) =>
  [h.title, usableText(h.snippet) ? h.snippet : '', h.seller && `Seller: ${h.seller}`, h.price && `Price: ${h.price}`, h.url].filter(Boolean).join('\n')

const prob = (answers: Answer[], name: string) => {
  const a = answers.find(x => x.name === name)
  if (!a || a.refused) return 0
  return (a.probabilities.find(p => p.value === true)?.p) ?? (a.value === true ? a.confidence : 0)
}

/** Nothing above this is "about even". Decisions answers 0.5 when it has nothing to go on. */
export const LIKELY_AT = 0.6
/** Sure enough that a page is commentary to take it out of the queue. */
export const DISCUSSES_AT = 0.7
export const DISCUSSES_WHY = 'Page discusses scams; not a takedown target'

/** Combines the predicates into one score, and says why in plain words for the dashboard. */
export function summarize(answers: Answer[]) {
  const imp = prob(answers, 'impersonating')
  const scam = prob(answers, 'scam')
  const discussing = prob(answers, 'discusses_scam')
  const discusses = discussing >= DISCUSSES_AT
  // The first two questions score pages about scams highly, so their score would mislead here.
  const score = discusses ? Math.min(Math.max(imp, scam), 1 - discussing) : Math.max(imp, scam)
  const sev = answers.find(a => a.name === 'severity')
  const severity = sev && !sev.refused ? 1 + Number(sev.value) : 1
  const used = answers.filter(a => a.name === 'impersonating' || a.name === 'scam')
  const confidence = used.length ? Math.min(...used.map(a => a.confidence)) : 0
  const parts = []
  if (imp >= LIKELY_AT) parts.push(`impersonation likely (${imp.toFixed(2)})`)
  if (scam >= LIKELY_AT) parts.push(`scam or giveaway language likely (${scam.toFixed(2)})`)
  const why = discusses ? DISCUSSES_WHY : parts.length ? parts.join('; ') : `low signal (impersonation ${imp.toFixed(2)}, scam ${scam.toFixed(2)})`
  return { score, severity, confidence, why, discusses }
}

const URL_LIKE = /^(https?:\/\/|www\.)\S*$/i
const BOT_WALL = /^\W*(prove your humanity|verify to continue|just a moment|attention required|access denied|enable javascript|checking your browser|are you a robot|loading\W*$)/i
const MIN_PAGE_TEXT = 60

/** Text that really came from the page, not a bot check or an empty shell. */
export const usableText = (t?: string) => !!t && t.trim().length >= MIN_PAGE_TEXT && !BOT_WALL.test(t.trim())

/** Whether a decision would have anything to read. A title that is only the URL says nothing. */
export const hasReadableEvidence = (h: Hit) =>
  usableText(h.evidenceText) || usableText(h.snippet) || (!!h.title.trim() && !URL_LIKE.test(h.title.trim()))
