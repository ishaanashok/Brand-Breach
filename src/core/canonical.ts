const TRACKING = /^(utm_.*|gclid|fbclid|msclkid|ref|ref_src|igshid|mc_eid|mc_cid|si|spm)$/i

export function canonicalUrl(raw: string, shortLinks: Record<string, string> = {}): string {
  const trimmed = raw.trim()
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return trimmed.toLowerCase()
  }
  u.protocol = 'https:'
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  u.hash = ''
  u.port = ''
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
  u.search = new URLSearchParams(kept).toString()
  const path = u.pathname.replace(/\/+$/, '')
  const out = `https://${u.hostname}${path}${u.search}`
  const expanded = shortLinks[out]
  return expanded ? canonicalUrl(expanded, {}) : out
}

export function caseId(brandSlug: string, url: string): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(`${brandSlug}\n${canonicalUrl(url)}`)
  return `case_${h.digest('hex').slice(0, 24)}`
}
