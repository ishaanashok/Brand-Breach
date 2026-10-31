import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deciderFromConfig } from '../deciders/config'
import { DEMO_TIMING } from '../harness/hunt-runner'
import { liveSource } from '../harness/live'
import { autoFallback } from '../harness/source'
import { loadTape, tapeSource } from '../harness/tape'
import { MemoryBus } from '../relay/memory'
import { relayBus } from '../relay/sdk'
import { actorStore } from '../store/actors'
import { MemoryStore } from '../store/memory'
import type { Store } from '../store/types'
import { createServer } from './api'

// Everything is chosen by configuration; see README for the matrix.
const env = process.env
const STATE_DIR = '.customs'
mkdirSync(STATE_DIR, { recursive: true })

const store: Store = env.CUSTOMS_STORE === 'file' ? new MemoryStore(`${STATE_DIR}/actors`) : await actorStore()
const tape = await loadTape()

const log = (s: string) => console.log(`[customs] ${s}`)
const { triage, verify, mode } = deciderFromConfig(env, {
  onFallback: (from, err) => log(`decider ${from} fell through: ${err}`),
  onShadow: l => log(`shadow ${l.primary} vs ${l.shadow}: ${l.agreed ? 'agree' : 'DISAGREE'}`),
})

// The key lets a restarted server rejoin the same Relay room, so it stays on local disk.
const keyFile = (huntId: string) => `${STATE_DIR}/relay-${huntId}.key`

const app = await createServer({
  port: Number(env.PORT ?? 3000),
  store, mode, triage, verify,
  verifyEstUsd: 0.002,
  timing: DEMO_TIMING,
  makeBus: async huntId => {
    if (env.CUSTOMS_BUS === 'memory') return new MemoryBus()
    const f = keyFile(huntId)
    return relayBus({
      workspaceKey: env.RELAY_WORKSPACE_KEY ?? (existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined),
      workspaceName: `customs-${huntId}`,
      onKey: k => writeFileSync(f, k, { mode: 0o600 }),
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

const resumed = await app.resumeAll()
log(`listening on http://localhost:${app.port} (deciders ${triage.id} / ${verify.id})${resumed.length ? `, resumed ${resumed.join(', ')}` : ''}`)
