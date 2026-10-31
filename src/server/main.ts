import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deciderFromConfig } from '../deciders/config'
import { DEMO_TIMING } from '../harness/hunt-runner'
import { liveSource } from '../harness/live'
import { autoFallback } from '../harness/source'
import { loadTape, tapeSource } from '../harness/tape'
import { MemoryBus } from '../relay/memory'
const relayBus = async (o: Parameters<typeof import("../relay/sdk").relayBus>[0]) => (await import("../relay/sdk")).relayBus(o)
import { reasonerFromConfig } from '../reasoners/config'
import { actorStore } from '../store/actors'
import { MemoryStore } from '../store/memory'
import type { Store } from '../store/types'
import { createServer, type DeciderLog } from './api'

// A dropped network promise should leave a trace, not take the running hunts down with it.
process.on('unhandledRejection', err => console.error('[customs] unhandled rejection:', err))

// Everything is chosen by configuration; see README for the matrix.
const env = process.env
const STATE_DIR = '.customs'
mkdirSync(STATE_DIR, { recursive: true })

const store: Store = env.CUSTOMS_STORE === 'file' ? new MemoryStore(`${STATE_DIR}/actors`) : await actorStore()
const tape = await loadTape()

const log = (s: string) => console.log(`[customs] ${s}`)
const deciderLog: DeciderLog = { fallbacks: [], shadow: [] }
const { triage, verify, mode } = deciderFromConfig(env, {
  onFallback: (from, error) => { deciderLog.fallbacks.push({ at: Date.now(), from, error }); log(`decider ${from} fell through: ${error}`) },
  onShadow: l => { deciderLog.shadow.push({ agreed: l.agreed }); log(`shadow ${l.primary} vs ${l.shadow}: ${l.agreed ? 'agree' : 'DISAGREE'}`) },
})

// Secrets that let a restarted server rejoin the same Relay room; local disk only.
const stateFile = (huntId: string) => `${STATE_DIR}/relay-${huntId}.json`

const kbFixtures = await Bun.file(new URL('../../tapes/kb.json', import.meta.url).pathname).json()
const reasoner = reasonerFromConfig(env, kbFixtures)

const billed = [
  ['target', 'hybrid', 'shadow'].includes(mode) && 'decisions',
  reasoner.id !== 'mock-reasoner' && 'reasoning',
  env.CUSTOMS_SOURCE === 'live' && 'search',
].filter((b): b is string => Boolean(b))

const app = await createServer({
  port: Number(env.PORT ?? 3000),
  billed,
  store, mode, triage, verify, reasoner, deciderLog,
  verifyEstUsd: 0.002,
  timing: DEMO_TIMING,
  makeBus: async huntId => {
    if (env.CUSTOMS_BUS === 'memory') return new MemoryBus()
    const f = stateFile(huntId)
    return relayBus({
      workspaceName: `customs-${huntId}`,
      state: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { tokens: {} },
      save: st => writeFileSync(f, JSON.stringify(st), { mode: 0o600 }),
    })
  },
  makeSource: (run, huntId) => {
    const replay = tapeSource(tape, { run, delayMs: 200 })
    if (env.CUSTOMS_SOURCE !== 'live') return replay
    if (!env.OPENAI_API_KEY) throw new Error('CUSTOMS_SOURCE=live needs OPENAI_API_KEY')
    return autoFallback(liveSource({ apiKey: env.OPENAI_API_KEY }), replay, {
      minHits: 5, withinMs: 30_000, onSwitch: reason => log(`${huntId} switched to tape: ${reason}`),
    })
  },
})

// With the actor runtime down there is nothing to resume yet, but the server still answers.
const resumed = await app.resumeAll().catch(err => { log(`could not resume hunts: ${err}`); return [] as string[] })
log(`listening on http://localhost:${app.port} (deciders ${triage.id} / ${verify.id}, reasoner ${reasoner.id})${resumed.length ? `, resumed ${resumed.join(', ')}` : ''}`)
