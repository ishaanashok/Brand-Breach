// Replays labelled pages through the real Decisions API and reports who would reach the review queue. Costs real money, a few cents per 100 pages.
// usage: bun --env-file=.env scripts/eval-queue.ts [labels.json] [--answers=saved.json] [--save=saved.json]
import { SEED_COMMENTARY } from '../src/core/commentary'
import { DEFAULT_THRESHOLD } from '../src/core/machines/brand'
import { earnsReading, thresholdFor } from '../src/core/policy'
import { DISCUSSES_AT, LIKELY_AT, hasReadableEvidence, hitText, summarize, triageQuestions, usableText, verifyQuestions } from '../src/core/questions'
import { rulesCheck } from '../src/core/rules'
import type { Answer, Hit } from '../src/core/types'
import { openaiDecider } from '../src/deciders/openai'

type Row = { id: string; brand: string; label?: string; url: string; surface: Hit['surface']; title: string; snippet: string; evidenceText: string; before: { state: string; triage: number | null; verify: number | null } }
type Saved = { triage: Answer[]; verify?: Answer[]; usd: number }

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const file = args.find(a => !a.startsWith('--')) ?? new URL('../tests/fixtures/queue-labels.json', import.meta.url).pathname
const rows: Row[] = await Bun.file(file).json()
const saved: Record<string, Saved> = flag('answers') ? await Bun.file(flag('answers')!).json() : {}

const brandName = (slug: string) => slug.replace(/-/g, ' ')
const hitOf = (r: Row): Hit => ({ url: r.url, surface: r.surface, title: r.title, snippet: r.snippet })
const readable = (r: Row) => hasReadableEvidence({ ...hitOf(r), evidenceText: r.evidenceText })

async function collect() {
  const decider = openaiDecider({ apiKey: process.env.OPENAI_API_KEY! })
  let next = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) {
      const r = rows[next++]!
      if (saved[r.id]) continue
      const t = await decider.decide({ text: hitText(hitOf(r)) }, triageQuestions(brandName(r.brand)), { timeoutMs: 30_000 })
      const out: Saved = { triage: t.answers, usd: t.usage.usd }
      if (readable(r)) {
        const text = [hitText(hitOf(r)), usableText(r.evidenceText) && `Captured evidence: ${r.evidenceText}`].filter(Boolean).join('\n')
        const v = await decider.decide({ text }, verifyQuestions(brandName(r.brand)), { timeoutMs: 30_000 })
        out.verify = v.answers
        out.usd += v.usage.usd
      }
      saved[r.id] = out
    }
  }))
}

type Outcome = 'queue' | 'cleared-rule' | 'cleared-triage' | 'cleared-verify' | 'unreadable' | 'low'
function outcome(r: Row, o: { list: boolean; likely: number; discusses: number }): { out: Outcome; score: number } {
  if (o.list && rulesCheck(hitOf(r), { officialDomains: [], authorizedSellers: [], whitelist: [], commentary: SEED_COMMENTARY }).clear) return { out: 'cleared-rule', score: 0 }
  const s = saved[r.id]!
  const prob = (a: Answer[]) => a.find(x => x.name === 'discusses_scam')?.probabilities.find(p => p.value === true)?.p ?? 0
  const t = summarize(s.triage)
  if (prob(s.triage) >= o.discusses) return { out: 'cleared-triage', score: t.score }
  if (!earnsReading(t.score, thresholdFor(DEFAULT_THRESHOLD, 'balanced'), hasReadableEvidence(hitOf(r)))) return { out: 'low', score: t.score }
  if (!s.verify) return { out: 'unreadable', score: 0 }
  const v = summarize(s.verify)
  if (prob(s.verify) >= o.discusses) return { out: 'cleared-verify', score: v.score }
  const raw = Math.max(...['impersonating', 'scam'].map(n => s.verify!.find(x => x.name === n)?.probabilities.find(p => p.value === true)?.p ?? 0))
  return raw >= o.likely ? { out: 'queue', score: raw } : { out: 'cleared-verify', score: raw }
}

const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '0/0')
function report(title: string, o: { list: boolean; likely: number; discusses: number }) {
  const res = rows.map(r => ({ r, ...outcome(r, o) }))
  const queue = res.filter(x => x.out === 'queue')
  const of = (l: string, text?: boolean) => res.filter(x => x.r.label === l && (text === undefined || !!x.r.evidenceText === text))
  const inQ = (xs: typeof res) => xs.filter(x => x.out === 'queue').length
  console.log(`\n${title} (likely ${o.likely}, discusses ${o.discusses})`)
  console.log(`  scam articles kept out: ${pct(of('scam_article').length - inQ(of('scam_article')), of('scam_article').length)}`)
  console.log(`  real abuse with text kept in: ${pct(inQ(of('real_abuse', true)), of('real_abuse', true).length)}`)
  console.log(`  real abuse, all, kept in: ${pct(inQ(of('real_abuse')), of('real_abuse').length)}`)
  console.log(`  queue size ${queue.length}, at 45-55%: ${pct(queue.filter(x => x.score >= 0.45 && x.score <= 0.55).length, queue.length)}`)
  const tally: Record<string, number> = {}
  for (const x of res) tally[x.out] = (tally[x.out] ?? 0) + 1
  console.log(`  outcomes: ${JSON.stringify(tally)}`)
  return res
}

await collect()
if (flag('save')) await Bun.write(flag('save')!, JSON.stringify(saved))
const beforeQ = rows.filter(r => r.before.state === 'awaiting_approval')
console.log(`Before, as recorded: ${beforeQ.length}/${rows.length} in the queue, ${pct(beforeQ.filter(r => (r.before.verify ?? 0) >= 0.45 && (r.before.verify ?? 0) <= 0.55).length, beforeQ.length)} at 45-55%`)
const res = report('After', { list: true, likely: LIKELY_AT, discusses: DISCUSSES_AT })
report('After, without the shared list', { list: false, likely: LIKELY_AT, discusses: DISCUSSES_AT })
for (const likely of [0.55, 0.6, 0.65, 0.7]) for (const discusses of [0.5, 0.6, 0.7, 0.8]) report('Sweep', { list: true, likely, discusses })
const wrong = res.filter(x => x.r.label === 'scam_article' ? x.out === 'queue' : x.r.label === 'real_abuse' && x.out !== 'queue' && x.r.evidenceText)
console.log('\nWrong:')
for (const w of wrong) console.log(`  ${w.r.label} ${w.out} ${w.score.toFixed(2)} ${w.r.url.slice(0, 90)}`)
const top = res.filter(x => x.out === 'queue').sort((a, b) => b.score - a.score).slice(0, 20)
console.log('\nTop of the queue:')
for (const x of top) console.log(`  ${x.score.toFixed(2)} ${x.r.label ?? ''} ${x.r.url.slice(0, 80)}`)
console.log(`\nEstimated Decisions cost, at the price in the code: $${Object.values(saved).reduce((a, s) => a + s.usd, 0).toFixed(4)}`)
