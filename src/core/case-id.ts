import { canonicalUrl } from './canonical'

const SEPARATOR = '--'

// Apart from canonical.ts because actor code imports that file and has no Bun global.
export function caseId(brandSlug: string, url: string): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(`${brandSlug}\n${canonicalUrl(url)}`)
  return `case_${brandSlug}${SEPARATOR}${h.digest('hex').slice(0, 24)}`
}

/** The actor holding this case: one of 16 per brand. Null for ids made before cases were grouped. */
export function caseShard(id: string): string | null {
  const at = id.lastIndexOf(SEPARATOR)
  if (!id.startsWith('case_') || at < 0) return null
  return `${id.slice('case_'.length, at)}-${id[at + SEPARATOR.length]}`
}
