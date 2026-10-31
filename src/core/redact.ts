const PATTERNS: RegExp[] = [
  /\b0x[a-fA-F0-9]{16,}\b/g,
  /\bbc1[a-z0-9]{20,}\b/g,
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
  /(?<![\w.])@[A-Za-z0-9_]{2,}/g,
  /\b(t\.me|discord\.gg|discord\.com\/invite)\/[A-Za-z0-9_-]+/g,
]

/** Blurs wallet addresses and account handles before anything reaches the screen. */
export const redact = (text: string) => PATTERNS.reduce((t, p) => t.replace(p, '█████'), text)

/** The same value always blurs the same way, so graph nodes stay connected. */
const blurred = (term: string) => `█████${Bun.hash(term).toString(16).slice(0, 4)}`

/** Handles carry no marker in seller fields or URL paths, so known values are blurred by name. */
export function sensitiveTerms(cases: { hit: { seller?: string; leads?: { kind: string; value: string }[] } | null }[], edges: { to: string }[]): string[] {
  const out = new Set<string>()
  for (const c of cases) {
    if (c.hit?.seller) out.add(c.hit.seller)
    for (const l of c.hit?.leads ?? []) if (l.kind !== 'domain') out.add(l.value)
  }
  for (const e of edges) {
    const m = e.to.match(/^(seller|wallet|channel):(.+)$/)
    if (m) out.add(m[2]!)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

export function redactDeep<T>(value: T, terms: string[] = []): T {
  if (typeof value === 'string') {
    return redact(terms.reduce((t, term) => t.replaceAll(term, blurred(term)), value)) as T
  }
  if (Array.isArray(value)) return value.map(v => redactDeep(v, terms)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, terms)])) as T
  }
  return value
}
