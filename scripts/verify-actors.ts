// Proves the PRD's race checks against the real Durable Actors runtime. Needs `bun run dev:actors` and `bun run generate`.
import { caseId } from '../src/core/case-id'
import { actorStore } from '../src/store/actors'

const store = await actorStore()
const tag = Date.now()

const hit = { url: 'https://race.example/x', surface: 'video' as const, title: 't', snippet: 's' }
const raceId = caseId(`verify-${tag}`, hit.url)
const c = store.kase(raceId)
const reports = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(n => c.report(raceId, 'verify', 'h', hit, n, Date.now())))
const firsts = reports.filter(r => r.first).length
console.log(`dedupe: ${firsts} first, ${reports.length - firsts} duplicates`)

// Many pages at once must share a fixed set of actors, with no case lost.
const pages = Array.from({ length: 600 }, (_, i) => caseId(`verify-${tag}`, `https://race.example/page/${i}`))
const started = performance.now()
const firstReports = await Promise.all(pages.map(id => store.kase(id).report(id, 'verify', 'h', hit, 'a', Date.now())))
const read = await Promise.all(pages.map(id => store.kase(id).snapshot()))
const kept = read.filter((s, i) => s.id === pages[i]).length
console.log(`shards: ${firstReports.filter(r => r.first).length} first, ${kept} of ${pages.length} kept, ${Math.round(performance.now() - started)}ms`)

const id = `budget_${tag}`
const h = store.hunt(id)
await h.init(id, { brand: 'Verify', keywords: [], officialDomains: [], authorizedSellers: [], budgetUsd: 0.1, precision: 'balanced' }, Date.now())
let peak = 0
await Promise.all(Array.from({ length: 5 }, (_, i) => (async () => {
  for (let n = 0; n < 15; n++) {
    const r = await h.reserve(`s${i}`, 0.01, Date.now())
    if (r.ok) await h.settle(r.id!, 0.01)
    peak = Math.max(peak, (await h.snapshot()).spent)
  }
})()))
const s = await h.snapshot()
console.log(`budget: spent ${s.spent.toFixed(4)} of 0.1000, peak ${peak.toFixed(4)}, overshoot ${Math.max(0, s.spent - 0.1).toFixed(6)}`)

const ok = firsts === 1 && s.spent <= 0.1 + 1e-9 && kept === pages.length
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
