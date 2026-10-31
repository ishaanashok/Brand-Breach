import { canonicalUrl } from './canonical'
import { matchKb, type KbEntity } from './kb'
import type { Hit } from './types'

export type RuleContext = { officialDomains: string[]; authorizedSellers: string[]; whitelist: string[]; kb?: KbEntity[] }
const STEEP_DISCOUNT = 0.5

const hostOf = (url: string) => {
  try { return new URL(canonicalUrl(url)).hostname } catch { return '' }
}
const isSubdomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** Stage 0 costs nothing, so it runs before any budget is spent on a candidate. */
export function rulesCheck(hit: Hit, ctx: RuleContext): { skip: string | null; priceFlag: boolean } {
  const host = hostOf(hit.url)
  const seller = hit.seller?.trim().toLowerCase()
  const has = (list: string[]) => !!seller && list.some(s => s.toLowerCase() === seller)
  const priceFlag = !!hit.price && !!hit.listPrice && hit.price / hit.listPrice < STEEP_DISCOUNT
  let skip: string | null = null
  if (ctx.officialDomains.some(d => isSubdomain(host, d.toLowerCase()))) skip = 'official domain'
  else if (has(ctx.authorizedSellers)) skip = 'authorized seller'
  else if (has(ctx.whitelist)) skip = 'whitelisted seller'
  else {
    const known = matchKb(hit, ctx.kb ?? [])
    if (known) skip = `verified ${known.kind} in knowledge base: ${known.value}`
  }
  return { skip, priceFlag }
}
