// Rebuilds tests/fixtures/queue-labels.json from a file store, read only. Labels are judgement calls: edit the lists, not the output.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: bun scripts/make-queue-fixture.ts <file store dir>')

const PER_HOST = 2
// Pages that warn about, report on or discuss a scam, by host.
const ARTICLE_HOSTS = `fleetstreetmag.com scamencyclopedia.org krebsonsecurity.com malware-guide.com which.co.uk makingsenseofsecurity.com mediamatters.org
albinternal.news.trendmicro.com elitedaily.com engadget.com tradingview.com oecd.ai boatos.org diesachsen.de yahoo.com malwaretips.com openscam.app
fashionunited.ca cointelegraph.com faux.fr it.tenable.com cryptorank.io scamwatcher.com lansing.legalexaminer.com tinybeans.com onlinethreatalerts.com
indicator.media techradar.com finbold.com alluresecurity.com fakewebsitebuster.com tomshardware.com tools.malwaretips.com scamadviser.com scam.directory
scanner.pcrisk.com phishdestroy.io resemble.ai arxiv.org app.midpage.ai`.split(/\s+/)
// Hosts or host/paths that sell fakes or impersonate the brand, read from the page text.
const ABUSE_PREFIXES = `chaneloutletshop.com chaneloutletstoreonline.com chaneloutletstores.com columbiausoutlet.com hokaoneonesports.com hokasfootwear.com
kickwho.is lulemone.com lululemon-renewal.netlify.app martify.co.in patagoniaclothing.uk poshmark.com/listing/replica-lululemon poshmark.com/listing/crazy-deals-chanel
hibid.com/utah/lot/258671802 sauconysale.com topgoosey.com uscolumbia-shop.com zaizheshoes.en.made-in-china.com anyflip.com/ttebv 2b5b7e-3.myshopify.com
msha.ke/fashionfeed t.me/s/lulul3mon t.me/s/voptasics linktr.ee/glhoka news-usa.today/the-truth-behind hacooesp.com/p/28848`.split(/\s+/)
const ABUSE_PER_HOST: Record<string, number> = { 'columbiausoutlet.com': 6, 'chaneloutletstores.com': 3 }
// Lookalike sites and scam forums with no page text, which show what happens to pages nobody could read.
const NO_TEXT_ABUSE = `brooksshoes.net columbiaoutdoorshop.com lululemonppo.my.canva.site columbie.us patagoniasusa.com patagoniasus.com extremecolumbiagiveaway.com
columbia.ua lululemonofficial.com brooksrunningmall.com lululemonportal.live`.split(/\s+/)
const NO_TEXT_ARTICLE = `bbb.org myantispyware.com scam-detector.com consumer.ftc.gov reddit.com/r/scams gridinsoft.com`.split(/\s+/)

const where = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').toLowerCase()
const hostOf = (url: string) => where(url).split(/[/?#]/)[0]!
const hasText = (c: any) => (c.hit.evidenceText?.length ?? 0) > 200 && !/^(prove your humanity|verify to continue)/i.test(c.hit.evidenceText)

const cases = readdirSync(dir).filter(f => f.startsWith('case')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter(c => c.hit && c.state === 'awaiting_approval')
  .sort((a, b) => a.id.localeCompare(b.id))

const take = (pass: (c: any) => boolean, group: (c: any) => string, cap: (g: string) => number) => {
  const used = new Map<string, number>()
  return cases.filter(c => {
    if (!pass(c)) return false
    const g = group(c)
    if ((used.get(g) ?? 0) >= cap(g)) return false
    used.set(g, (used.get(g) ?? 0) + 1)
    return true
  })
}
const prefix = (list: string[]) => (c: any) => list.find(p => where(c.hit.url).startsWith(p)) ?? ''

const row = (label: string) => (c: any) => ({
  id: c.id, brand: c.brand, label, url: c.hit.url, surface: c.hit.surface, title: c.hit.title, snippet: c.hit.snippet ?? '',
  evidenceText: c.hit.evidenceText ?? '',
  before: { state: c.state, triage: c.triage?.score ?? null, verify: c.verification?.score ?? null },
})

const out = [
  ...take(c => hasText(c) && ARTICLE_HOSTS.includes(hostOf(c.hit.url)), c => hostOf(c.hit.url), () => PER_HOST).map(row('scam_article')),
  ...take(c => hasText(c) && !!prefix(ABUSE_PREFIXES)(c), prefix(ABUSE_PREFIXES), g => ABUSE_PER_HOST[g] ?? 1).map(row('real_abuse')),
  ...take(c => !c.hit.evidenceText && NO_TEXT_ARTICLE.some(p => where(c.hit.url).startsWith(p)), prefix(NO_TEXT_ARTICLE), () => 2).map(row('scam_article')),
  ...take(c => !c.hit.evidenceText && NO_TEXT_ABUSE.includes(hostOf(c.hit.url)), c => hostOf(c.hit.url), () => 1).map(row('real_abuse')),
]
await Bun.write(new URL('../tests/fixtures/queue-labels.json', import.meta.url).pathname, JSON.stringify(out, null, 1) + '\n')
const count = (f: (r: any) => boolean) => out.filter(f).length
console.log(`scam articles: ${count(r => r.label === 'scam_article' && r.evidenceText)} with text, ${count(r => r.label === 'scam_article' && !r.evidenceText)} without`)
console.log(`real abuse: ${count(r => r.label === 'real_abuse' && r.evidenceText)} with text, ${count(r => r.label === 'real_abuse' && !r.evidenceText)} without`)

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 90)
await Bun.write(new URL('../tests/fixtures/queue-labels.md', import.meta.url).pathname, `# Labels for the review queue test set

These are judgement calls made by reading stored page text, so please correct any you disagree with. To change one, edit the lists in \`scripts/make-queue-fixture.ts\` and rerun it. Every page here sat in the review queue before this work, so the set shows what leaves the queue, not what was missing from it.

| Label | Brand | Page text | Score before | URL |
| --- | --- | --- | --- | --- |
${out.sort((a, b) => a.label.localeCompare(b.label) || a.url.localeCompare(b.url)).map(r => `| ${r.label === 'scam_article' ? 'Scam article' : 'Real abuse'} | ${r.brand} | ${r.evidenceText ? 'yes' : 'no'} | ${r.before.verify === null ? '' : `${Math.round(r.before.verify * 100)}%`} | \`${cell(r.url)}\` |`).join('\n')}
`)
