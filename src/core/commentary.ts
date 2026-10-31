import { SHARED_HOSTS } from './kb.js'

/** Places that write about scams rather than commit them, whichever brand a hunt is for. Each is a host or host/path. */
export const SEED_COMMENTARY = [
  // Consumer protection
  'consumer.ftc.gov', 'reportfraud.ftc.gov', 'ic3.gov', 'bbb.org', 'consumerfinance.gov', 'actionfraud.police.uk', 'which.co.uk', 'snopes.com', 'boatos.org',
  // Scam checkers
  'scamadviser.com', 'scam-detector.com', 'scamwatcher.com', 'scamencyclopedia.org', 'scam.directory', 'openscam.app', 'fakewebsitebuster.com', 'phishdestroy.io', 'onlinethreatalerts.com',
  // Security vendors and writers
  'malwaretips.com', 'malware-guide.com', 'makingsenseofsecurity.com', 'myantispyware.com', 'gridinsoft.com', 'pcrisk.com', 'krebsonsecurity.com', 'trendmicro.com', 'tenable.com', 'malwarebytes.com', 'kaspersky.com', 'norton.com',
  // Scam forums on a shared platform, never the platform itself
  'reddit.com/r/scams', 'reddit.com/r/scam', 'reddit.com/r/isthisascam', 'reddit.com/r/phishing', 'reddit.com/r/legitcheck',
]

/** The normal form of an entry, or null if it would cover a whole shared platform. */
export function normalizeCommentary(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
  const host = v.split('/')[0]!
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  return v.includes('/') || !SHARED_HOSTS.has(host) ? v : null
}

/** The entry covering this page, if any. Paths match whole segments, so r/scams doesn't cover r/scamsters. */
export function matchCommentary(url: string, list: string[]): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.toLowerCase().replace(/\/+$/, '')
  for (const entry of list) {
    const [h, ...rest] = entry.split('/')
    const p = rest.length ? `/${rest.join('/')}` : ''
    if ((host === h || host.endsWith(`.${h}`)) && (path === p || path.startsWith(`${p}/`))) return entry
  }
  return null
}
