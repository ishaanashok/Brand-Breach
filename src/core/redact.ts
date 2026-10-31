const PATTERNS: RegExp[] = [
  /\b0x[a-fA-F0-9]{16,}\b/g,
  /\bbc1[a-z0-9]{20,}\b/g,
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
  /(?<![\w.])@[A-Za-z0-9_]{2,}/g,
  /\b(t\.me|discord\.gg|discord\.com\/invite)\/[A-Za-z0-9_-]+/g,
]

/** Blurs wallet addresses and account handles before anything reaches the screen. */
export const redact = (text: string) => PATTERNS.reduce((t, p) => t.replace(p, '█████'), text)

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T
  }
  return value
}
