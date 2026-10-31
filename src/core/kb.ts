import { canonicalUrl } from './canonical.js'
import type { Hit } from './types.js'

export type KbKind = 'domain' | 'account' | 'seller' | 'channel'
export type KbSource = 'operator' | 'reasoner' | 'human'
export type KbEntity = {
  id: string
  kind: KbKind
  /** Domain: `tesla.com`. Account or channel: `host/path`. Seller: the name. All lowercase. */
  value: string
  source: KbSource
  confidence: number
  evidence: string
  /** Only verified entities clear a hit; candidates are shown and given to reasoners as hints. */
  status: 'verified' | 'candidate'
}
export type BrandKb = { entities: KbEntity[]; builtBy: string | null; builtAt: number | null; removed: string[] }
export type KbProposal = { kind: string; value: string; confidence: number; evidence?: string }

export const emptyKb = (): BrandKb => ({ entities: [], builtBy: null, builtAt: null, removed: [] })

export const VERIFY_AT = 0.8

const KINDS: KbKind[] = ['domain', 'account', 'seller', 'channel']
// Trusting a whole platform would clear every scam hosted on it.
const SHARED_HOSTS = new Set([
  'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'reddit.com',
  'threads.net', 'pinterest.com', 'twitch.tv', 'discord.com', 'discord.gg', 't.me', 'telegram.org', 'telegram.me', 'whatsapp.com', 'wa.me',
  'amazon.com', 'ebay.com', 'etsy.com', 'aliexpress.com', 'walmart.com', 'temu.com', 'shopify.com', 'myshopify.com', 'wordpress.com', 'wix.com',
  'github.com', 'github.io', 'medium.com', 'substack.com', 'blogspot.com', 'linktr.ee', 'bit.ly', 'google.com', 'sites.google.com', 'apple.com',
])

const stripHost = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')

/** The normal form of a value, or null if it cannot safely be trusted as this kind. */
export function normalizeKb(kind: KbKind, raw: string): string | null {
  const v = stripHost(raw)
  if (!v) return null
  if (kind === 'seller') return v.replace(/^@/, '')
  const host = v.split('/')[0]!
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  if (kind === 'domain') return v.includes('/') || SHARED_HOSTS.has(host) ? null : host
  // An account is a place on a host, so a bare host would trust everyone on it.
  return v.includes('/') ? v : null
}

export function entityFrom(kind: KbKind, raw: string, source: KbSource, confidence: number, evidence: string): KbEntity | null {
  const value = normalizeKb(kind, raw)
  if (!value) return null
  const trusted = source !== 'reasoner' || confidence >= VERIFY_AT
  return { id: `${kind}:${value}`, kind, value, source, confidence, evidence, status: trusted ? 'verified' : 'candidate' }
}

/** Keeps what a model proposed only if it passes the same rules as everything else. */
export function fromProposals(proposals: KbProposal[]): KbEntity[] {
  const out: KbEntity[] = []
  for (const p of proposals) {
    if (!KINDS.includes(p.kind as KbKind) || typeof p.value !== 'string' || typeof p.confidence !== 'number') continue
    const e = entityFrom(p.kind as KbKind, p.value, 'reasoner', Math.min(1, Math.max(0, p.confidence)), String(p.evidence ?? '').slice(0, 300))
    if (e) out.push(e)
  }
  return out
}

const RANK: Record<KbSource, number> = { reasoner: 0, operator: 1, human: 2 }

/** Merges by id. People outrank models, and an entry a person removed stays out. */
export function mergeKb(kb: BrandKb, incoming: KbEntity[]): KbEntity[] {
  const byId = new Map(kb.entities.map(e => [e.id, e]))
  for (const e of incoming) {
    if (kb.removed.includes(e.id) && e.source === 'reasoner') continue
    const have = byId.get(e.id)
    if (!have || RANK[e.source] >= RANK[have.source]) byId.set(e.id, e)
  }
  return [...byId.values()]
}

/** What the operator typed counts as verified without being stored twice. */
export function kbEntities(b: { kb?: BrandKb; officialDomains: string[]; authorizedSellers: string[] }): KbEntity[] {
  const kb = b.kb ?? emptyKb()
  const typed = [
    ...b.officialDomains.map(d => entityFrom('domain', d, 'operator', 1, 'Entered by the operator')),
    ...b.authorizedSellers.map(s => entityFrom('seller', s, 'operator', 1, 'Entered by the operator')),
  ].filter((e): e is KbEntity => !!e && !kb.removed.includes(e.id))
  return mergeKb(kb, typed)
}

const hostPath = (url: string) => {
  try {
    const u = new URL(canonicalUrl(url))
    return { host: u.hostname.replace(/^www\./, ''), path: `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/+$/, '').toLowerCase() }
  } catch { return { host: '', path: '' } }
}

/** The verified entity this hit belongs to, if any. */
export function matchKb(hit: Pick<Hit, 'url' | 'seller'>, entities: KbEntity[]): KbEntity | null {
  const { host, path } = hostPath(hit.url)
  const seller = hit.seller?.trim().toLowerCase().replace(/^@/, '')
  for (const e of entities) {
    if (e.status !== 'verified') continue
    if (e.kind === 'domain' && (host === e.value || host.endsWith(`.${e.value}`))) return e
    if ((e.kind === 'account' || e.kind === 'channel') && (path === e.value || path.startsWith(`${e.value}/`))) return e
    if (e.kind === 'seller' && seller === e.value) return e
  }
  return null
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]!
}

/** A verified domain this host looks like. Name similarity alone is a hint, never a verdict. */
export function resembles(url: string, entities: KbEntity[]): KbEntity | null {
  const label = hostPath(url).host.split('.')[0] ?? ''
  if (!label) return null
  for (const e of entities) {
    if (e.kind !== 'domain' || e.status !== 'verified') continue
    const own = e.value.split('.')[0]!
    if (own.length < 4) continue
    if (label !== own && (label.includes(own) || distance(label, own) <= 2)) return e
    if (label === own && hostPath(url).host !== e.value) return e
  }
  return null
}
