import type { KbProposal } from '../core/kb'
import type { Assessment, Reasoner } from './types'

const BAD = /(replica|counterfeit|knockoff|double your|send .*(btc|eth|crypto)|airdrop|connect wallet|deepfake|fake)/i
const FINE = /(review|forum|news|fan club|third party|compatible|explainer|repair guide|community)/i

/**
 * Keyword stand-in for a reasoning model, used without an API key.
 * It shows its id everywhere, so its verdicts are never mistaken for Luna's.
 * `fixtures` plays the part of web research with synthetic data, keyed by brand slug.
 */
export function mockReasoner({ fixtures = {}, delayMs = 0, usd = 0.004 }: { fixtures?: Record<string, KbProposal[]>; delayMs?: number; usd?: number } = {}): Reasoner {
  const wait = () => (delayMs ? Bun.sleep(delayMs) : Promise.resolve())
  return {
    id: 'mock-reasoner',
    kbEstUsd: usd,
    assessEstUsd: usd,
    async buildKb(r) {
      await wait()
      const slug = r.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      return { proposals: fixtures[slug] ?? [], usage: { usd, latencyMs: delayMs } }
    },
    async assess(r): Promise<Assessment> {
      await wait()
      const text = [r.hit.title, r.hit.snippet, r.hit.evidenceText].filter(Boolean).join(' ')
      const [bad, fine] = [BAD.test(text), FINE.test(text)]
      const usage = { usd, latencyMs: delayMs }
      if (fine && !/(double your|send .*(btc|eth|crypto)|connect wallet)/i.test(text.replace(/"[^"]*"/g, ''))) return { verdict: 'legitimate', confidence: 0.82, reasoning: 'Reads as commentary or third-party content, with no request for money or claim to be the brand.', usage }
      if (bad) return { verdict: 'infringing', confidence: 0.88, reasoning: 'Asks for money or sells replicas while trading on the brand name.', usage }
      return { verdict: 'unsure', confidence: 0.4, reasoning: 'Not enough evidence either way; a person should look.', usage }
    },
  }
}
