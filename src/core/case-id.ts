import { canonicalUrl } from './canonical'

// Apart from canonical.ts because actor code imports that file and has no Bun global.
export function caseId(brandSlug: string, url: string): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(`${brandSlug}\n${canonicalUrl(url)}`)
  return `case_${h.digest('hex').slice(0, 24)}`
}
