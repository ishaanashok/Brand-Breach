// Generates the synthetic demo tape. Every domain is under the reserved .example TLD
// and every seller, wallet and channel is invented, so no real account appears on screen.
import type { Hit, Surface } from '../src/core/types'

const h = (surface: Surface, url: string, title: string, snippet: string, truth: boolean, extra: Partial<Hit> = {}): Hit =>
  ({ url: `https://${url}`, surface, title, snippet, truth, ...extra })

const wallet = '0xFEED00000000000000000000000000000000BEEF'
const lanes: { source: Surface; strategy: string; pages: Hit[][]; blocked?: string }[] = [
  { source: 'marketplace', strategy: 'accessories', pages: [
    [h('marketplace', 'shopnow.example/item/key-fob-case', 'Key fob case for Model 3', 'Silicone case, third party, fits Tesla key fob. Review 4.5 stars.', false, { seller: 'casemaker' }),
     h('marketplace', 'shopnow.example/item/floor-mats', 'All-weather floor mats', 'Third party mats compatible with Tesla Model Y. Review 4.2 stars.', false, { seller: 'matworks' })],
    [h('marketplace', 'shopnow.example/item/charger-adapter', 'Charger adapter', 'Compatible charger adapter, news coverage and review inside.', false, { seller: 'chargeco' })],
  ] },
  { source: 'marketplace', strategy: 'discount-parts', pages: [
    [h('marketplace', 'bargainparts.example/tesla-wall-connector?batch={run}', 'Tesla Wall Connector 90% off replica', 'Replica wall connector with Tesla logo, counterfeit certification sticker.', true, { seller: 'voltking88', price: 49, listPrice: 475, leads: [{ kind: 'domain', value: 'tesla-parts-outlet.example', note: 'seller links here' }], evidenceText: 'Listing uses the Tesla logo and claims factory origin. Replica certification sticker visible. Ships from unverified warehouse.' }),
     h('marketplace', 'bargainparts.example/tesla-badge-set', 'Tesla badge set replica', 'Knockoff replica badges sold as genuine Tesla parts.', true, { seller: 'voltking88', price: 12, listPrice: 60, evidenceText: 'Knockoff badge set described as genuine. Seller has repeat listings.' })],
    [h('marketplace', 'autodeals.example/tesla-model3-wheel-cover?batch={run}', 'Model 3 wheel covers 90% off', 'Counterfeit Tesla wheel covers, limited claim price.', true, { seller: 'wheelz4less', price: 20, listPrice: 200, evidenceText: 'Counterfeit wheel covers with copied Tesla branding.' })],
  ] },
  { source: 'social', strategy: 'promo-accounts', pages: [
    [h('social', 'chirp.example/teslafan/status/1', 'Tesla owners fan club meetup', 'Fan club forum discussion of a local meetup.', false),
     h('social', 'chirp.example/evnews/status/2', 'EV news roundup', 'News and review of the latest EV deliveries.', false)],
  ] },
  { source: 'social', strategy: 'giveaway-posts', pages: [
    [h('social', 'chirp.example/musk_official_gift/status/{run}01', 'Tesla $100M crypto giveaway!', 'Send ETH to double your crypto. Official promo with free Tesla draw. Wallet in bio.', true, { seller: 'musk_official_gift', leads: [{ kind: 'wallet', value: wallet, note: 'wallet in bio' }, { kind: 'seller', value: 'voltking88', note: 'same promo link' }], evidenceText: 'Post uses an AI generated portrait and promises to double any crypto sent to a wallet. Giveaway language throughout.' }),
     h('social', 'chirp.example/tesla_airdrop/status/{run}02', 'Tesla airdrop ends tonight', 'Airdrop giveaway for holders. Connect wallet to claim.', true, { seller: 'tesla_airdrop', leads: [{ kind: 'channel', value: 'tesla-airdrop-vip', note: 'joins this channel' }], evidenceText: 'Airdrop giveaway promising free tokens, asks for wallet connection.' })],
    [h('social', 'grambook.example/p/tesla-free-car-{run}', 'Free Tesla for the first 1000', 'Free Tesla giveaway, limited claim, send small fee to wallet.', true, { seller: 'teslagifts', evidenceText: 'Free Tesla giveaway asks for an upfront fee sent to a wallet.' })],
  ] },
  { source: 'channels', strategy: 'discord-invites', pages: [
    [h('channels', 'chatservers.example/server/ev-owners', 'EV owners community', 'Public forum discussion for owners, repair guide pinned.', false)],
  ] },
  { source: 'channels', strategy: 'telegram-groups', pages: [
    [h('channels', 'msgr.example/s/tesla-airdrop-vip', 'Tesla Airdrop VIP', 'Official promo group. Double your crypto with our giveaway. Wallet pinned.', true, { seller: 'tesla-airdrop-vip', leads: [{ kind: 'domain', value: 'tesla-x2-promo.example', note: 'pinned link' }, { kind: 'wallet', value: wallet, note: 'pinned wallet' }], evidenceText: 'Group pins a wallet and repeats double-your-crypto giveaway language.' })],
    [h('channels', 'msgr.example/s/musk-signals-{run}', 'Musk crypto signals', 'Fake signals, send crypto to wallet for giveaway entry.', true, { seller: 'musk-signals', evidenceText: 'Fake signals group using deepfake clips and giveaway language.' })],
  ] },
  { source: 'domains', strategy: 'parked-names', pages: [
    [h('domains', 'teslaforum.example', 'Tesla owners forum', 'Forum discussion and repair guide by owners.', false),
     h('domains', 'evreviews.example/tesla', 'Tesla reviews', 'Independent review site with news.', false)],
  ] },
  { source: 'domains', strategy: 'lookalike-sites', pages: [
    [h('domains', 'tesla-x2-promo.example', 'Tesla official promo', 'Official promo: double your crypto in the Tesla giveaway. Send to wallet now.', true, { leads: [{ kind: 'wallet', value: wallet, note: 'on landing page' }], evidenceText: 'Lookalike landing page copies Tesla styling, shows a countdown and a wallet address for a giveaway.' }),
     h('domains', 'tesla-parts-outlet.example', 'Tesla parts outlet', 'Replica counterfeit parts at 90% off.', true, { evidenceText: 'Storefront uses Tesla logo and sells replica parts.' })],
    [h('domains', 'getteslacrypto-{run}.example', 'Get Tesla Crypto', 'Airdrop giveaway site. Connect wallet.', true, { evidenceText: 'Airdrop site asks visitors to connect a wallet for a giveaway.' })],
  ] },
  { source: 'video', strategy: 'owner-reviews', pages: [
    [h('video', 'streamtube.example/watch?v=ownerreview', 'Model Y one year owner review', 'Honest owner review and news.', false)],
  ] },
  { source: 'video', strategy: 'deepfake-streams', pages: [
    [h('video', 'streamtube.example/watch?v=muskgiveaway{run}', 'LIVE: Musk announces $100M Tesla giveaway', 'Deepfake livestream. Double your crypto, official promo, send to wallet in the description.', true, { seller: 'tesla-live-event', leads: [{ kind: 'domain', value: 'tesla-x2-promo.example', note: 'link in description' }, { kind: 'channel', value: 'tesla-airdrop-vip', note: 'pinned comment' }], evidenceText: 'Keyframes show a deepfake of the CEO over looping footage. Description links to a giveaway site with a wallet.' })],
    [h('video', 'streamtube.example/watch?v=teslacryptolive{run}', 'Tesla crypto event live', 'AI deepfake giveaway stream.', true, { seller: 'tesla-live-event', evidenceText: 'Deepfake stream, giveaway language, same channel as an earlier case.' })],
  ] },
]

// A site that refuses the scout, and a lane nobody owns, so the orchestrator has to change direction.
lanes.push({ source: 'social', strategy: 'short-video-ads', blocked: 'HTTP 403 from the search provider', pages: [] })
lanes.push({ source: 'domains', strategy: 'crypto-landing', pages: [
  [h('domains', 'quickcoin-rewards-{run}.example', 'Tesla rewards portal', 'Claim rewards for car owners.', true, { evidenceText: 'Page copies Tesla branding and asks visitors to connect wallet to claim.' })],
] })
// Quiet listings the quick decision cannot call. Only the richer look settles them.
const quiet = lanes.find(l => l.strategy === 'accessories')!
quiet.pages[0]!.push(h('marketplace', 'shopnow.example/item/model-3-bundle-{run}', 'Model 3 start-up bundle', 'Bundle for new owners, ships worldwide.', true, { seller: 'evbundles-co', evidenceText: 'Photos show counterfeit Tesla branding on every item.' }))
quiet.pages[0]!.push(h('marketplace', 'shopnow.example/item/wall-plate-{run}', 'Charging wall plate', 'Plate for home charging setups.', false, { evidenceText: 'Plain product photos, no logos.' }))

// The brand's own presences turn up in searches too. The knowledge base should clear these for free.
const own = (strategy: string, hit: Hit) => lanes.find(l => l.strategy === strategy)!.pages[0]!.push(hit)
own('promo-accounts', h('social', 'chirp.example/tesla/status/7', 'Tesla: Referral program update', 'Account post about changes to the referral program.', false))
own('accessories', h('marketplace', 'shopnow.example/store/tesla-official/wall-connector', 'Wall Connector', 'Wall Connector from the brand store at list price.', false, { seller: 'tesla-official-store', price: 450, listPrice: 450 }))
own('discord-invites', h('channels', 'msgr.example/s/tesla-owners-official', 'Official Tesla owners group', 'Brand-run group for owner meetups and service notes.', false))

// The same landing page surfaces in several lanes, so racing scouts really do collide.
const shared = h('domains', 'tesla-x2-promo.example/?utm_source=stream', 'Tesla official promo', 'Official promo: double your crypto in the Tesla giveaway. Send to wallet now.', true, { evidenceText: 'Lookalike landing page copies Tesla styling, shows a countdown and a wallet address for a giveaway.' })
for (const l of lanes) {
  if (['deepfake-streams', 'telegram-groups', 'giveaway-posts', 'discount-parts'].includes(l.strategy)) l.pages[0]!.push({ ...shared, surface: l.source })
}
// A news article that quotes scam language: a realistic false positive for the reject flow.
lanes.find(l => l.strategy === 'lookalike-sites')!.pages[0]!.push(h('domains', 'autonewsdaily.example/how-the-giveaway-scam-works', 'How the Tesla giveaway scam works', 'Explainer quoting "double your crypto" and "send to wallet" so readers can spot the fake giveaway.', false, { seller: 'autonewsdaily', evidenceText: 'Consumer news article warning readers about a fake giveaway, quoting double your crypto wallet language.' }))

const leadResults: Record<string, Hit[]> = {
  'seller:voltking88': [h('marketplace', 'bargainparts.example/tesla-powerwall-replica?batch={run}', 'Powerwall replica', 'Counterfeit Tesla Powerwall casing from same seller.', true, { seller: 'voltking88', price: 300, listPrice: 9000, evidenceText: 'Same seller, counterfeit casing, copied branding.' })],
  'domain:tesla-parts-outlet.example': [h('domains', 'tesla-parts-outlet.example/deals', 'Outlet deals', 'Replica parts deal page with fake certificates.', true, { evidenceText: 'Deal page for replica parts, fake certificates.' })],
  'domain:tesla-x2-promo.example': [h('domains', 'tesla-x2-promo.example/claim', 'Claim your giveaway', 'Send crypto to claim the Tesla giveaway.', true, { evidenceText: 'Claim page with wallet and giveaway language.' })],
  'channel:tesla-airdrop-vip': [h('channels', 'msgr.example/s/tesla-airdrop-vip/88', 'Pinned airdrop post', 'Airdrop giveaway pinned post with wallet.', true, { evidenceText: 'Pinned giveaway post with wallet.' })],
  [`wallet:${wallet}`]: [h('channels', 'msgr.example/s/double-your-eth', 'Double your ETH', 'Same wallet, double your crypto giveaway group.', true, { evidenceText: 'Another group using the same wallet for a giveaway.' })],
}

const tape = { note: 'SYNTHETIC demo data. All domains are reserved .example names; all sellers and wallets are invented.', searchUsd: 0.002, lanes, leadResults }
await Bun.write(new URL('../tapes/tesla.json', import.meta.url).pathname, JSON.stringify(tape, null, 1))

// What a reasoning model would plausibly return for this brand, for offline runs. Also synthetic.
const kb = { note: 'SYNTHETIC stand-in for web research. Used only by the mock reasoner.', tesla: [
  { kind: 'domain', value: 'tesla.com', confidence: 0.99, evidence: 'Synthetic: the brand site' },
  { kind: 'domain', value: 'shop.tesla.com', confidence: 0.97, evidence: 'Synthetic: linked from the brand site' },
  { kind: 'account', value: 'chirp.example/tesla', confidence: 0.96, evidence: 'Synthetic: linked from the brand site' },
  { kind: 'account', value: 'streamtube.example/teslaofficial', confidence: 0.93, evidence: 'Synthetic: linked from the brand site' },
  { kind: 'channel', value: 'msgr.example/s/tesla-owners-official', confidence: 0.86, evidence: 'Synthetic: named in brand community page' },
  { kind: 'seller', value: 'tesla-official-store', confidence: 0.9, evidence: 'Synthetic: brand store on the marketplace' },
  { kind: 'domain', value: 'teslaforum.example', confidence: 0.55, evidence: 'Synthetic: long-running fan forum, ownership unclear' },
  { kind: 'domain', value: 'chirp.example', confidence: 0.2, evidence: 'Synthetic: a model mistake the bar should stop' },
] }
await Bun.write(new URL('../tapes/kb.json', import.meta.url).pathname, JSON.stringify(kb, null, 1))
