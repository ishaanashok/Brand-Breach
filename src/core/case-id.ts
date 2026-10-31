import { canonicalUrl } from './canonical'

const SEPARATOR = '--'

// Apart from canonical.ts because actor code imports that file and has no Bun global.
export function caseId(brandSlug: string, url: string): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(`${brandSlug}\n${canonicalUrl(url)}`)
  return `case_${brandSlug}${SEPARATOR}${h.digest('hex').slice(0, 24)}`
}

/** The brand whose actor holds this case. */
export function caseBrand(id: string): string {
  return id.slice('case_'.length, id.lastIndexOf(SEPARATOR))
}
