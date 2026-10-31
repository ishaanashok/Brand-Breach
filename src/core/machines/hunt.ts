import type { HuntInput, Lane, Step } from '../types.js'

export type ScoutEntry = { lane: Lane; status: string; lastSeen: number; laneChangedAt: number }
export type Counters = {
  seen: number; triaged: number; shortlisted: number; verified: number
  approved: number; rejected: number; duplicates: number; skipped: number; undecided: number; fallbacks: number; reasoned: number; searches: number
}
export type SteerKind = 'exhausted' | 'blocked' | 'stalled' | 'yield' | 'cross-surface' | 'manual'
export type Spawn = { agent: string; caseId: string; trigger: string; reasonerId: string; at: number; endedAt?: number; outcome?: string }
export type HuntStatus = 'new' | 'running' | 'paused' | 'budget_exhausted' | 'done'

export type HuntState = {
  id: string
  version: number
  input: HuntInput | null
  status: HuntStatus
  mode: string
  spent: number
  overshootPreventedUsd: number
  reservations: Record<string, { usd: number; scout: string; at: number }>
  settled: string[]
  nextId: number
  roster: Record<string, ScoutEntry>
  counters: Counters
  caseIds: string[]
  steers: { at: number; scout: string; from: string; to: string; reason: string; kind: SteerKind }[]
  spawns: Spawn[]
  events: { at: number; text: string }[]
  firstVerifiedAt: number | null
  firstVerifiedSpend: number | null
  startedAt: number
}

const RESERVATION_TTL_MS = 60_000
const MAX_EVENTS = 200
const MAX_SETTLED = 2000

export const initialHunt = (): HuntState => ({
  id: '', version: 0, input: null, status: 'new', mode: '', spent: 0, overshootPreventedUsd: 0,
  reservations: {}, settled: [], nextId: 1, roster: {}, caseIds: [], steers: [], spawns: [], events: [],
  counters: { seen: 0, triaged: 0, shortlisted: 0, verified: 0, approved: 0, rejected: 0, duplicates: 0, skipped: 0, undecided: 0, fallbacks: 0, reasoned: 0, searches: 0 },
  firstVerifiedAt: null, firstVerifiedSpend: null, startedAt: 0,
})

const v = (s: HuntState, patch: Partial<HuntState>): HuntState => ({ ...s, ...patch, version: s.version + 1 })
const reserved = (s: HuntState) => Object.values(s.reservations).reduce((a, r) => a + r.usd, 0)

function expire(s: HuntState, now: number): HuntState {
  const live = Object.entries(s.reservations).filter(([, r]) => now - r.at < RESERVATION_TTL_MS)
  return live.length === Object.keys(s.reservations).length ? s : { ...s, reservations: Object.fromEntries(live) }
}

export type ReserveResult = { ok: boolean; id?: string; reason?: 'budget_exhausted' | 'paused' | 'stopped' }

export const hunt = {
  init(s: HuntState, id: string, input: HuntInput, now: number, mode = ''): Step<HuntState, HuntState> {
    if (s.input) return [s, s]
    const next = v(s, { id, input, status: 'running', startedAt: now, mode })
    return [next, next]
  },

  reserve(s0: HuntState, scout: string, usd: number, now: number): Step<HuntState, ReserveResult> {
    const s = expire(s0, now)
    if (s.status === 'paused') return [s, { ok: false, reason: 'paused' }]
    if (s.status !== 'running') return [s, { ok: false, reason: 'stopped' }]
    if (s.spent + reserved(s) + usd > s.input!.budgetUsd + 1e-12) {
      // Other reservations may still settle low, so only stop once nothing is outstanding.
      const stop = Object.keys(s.reservations).length === 0
      return [stop ? v(s, { status: 'budget_exhausted' }) : s, { ok: false, reason: 'budget_exhausted' }]
    }
    const id = `r${s.nextId}`
    return [
      v(s, { nextId: s.nextId + 1, reservations: { ...s.reservations, [id]: { usd, scout, at: now } } }),
      { ok: true, id },
    ]
  },

  settle(s: HuntState, id: string, actualUsd: number): Step<HuntState, { spent: number }> {
    if (s.settled.includes(id)) return [s, { spent: s.spent }]
    const { [id]: held, ...rest } = s.reservations
    const room = Math.max(0, s.input!.budgetUsd - s.spent - reserved({ ...s, reservations: rest }))
    const charged = Math.min(Math.max(0, actualUsd), room)
    const next = v(s, {
      reservations: rest,
      settled: [...s.settled, id].slice(-MAX_SETTLED),
      spent: s.spent + charged,
      overshootPreventedUsd: s.overshootPreventedUsd + Math.max(0, actualUsd - charged),
    })
    return [next, { spent: next.spent }]
  },

  registerScout(s: HuntState, name: string, lane: Lane, now: number): Step<HuntState, Lane> {
    const prev = s.roster[name]
    // A restarted scout keeps the lane the actor remembers.
    const entry: ScoutEntry = prev
      ? { ...prev, status: 'online', lastSeen: now }
      : { lane, status: 'online', lastSeen: now, laneChangedAt: now }
    return [v(s, { roster: { ...s.roster, [name]: entry } }), entry.lane]
  },

  setScoutStatus(s: HuntState, name: string, status: string, now: number): Step<HuntState, null> {
    const prev = s.roster[name]
    if (!prev) return [s, null]
    return [v(s, { roster: { ...s.roster, [name]: { ...prev, status, lastSeen: now } } }), null]
  },

  setLane(s: HuntState, name: string, lane: Lane, reason: string, now: number, kind: SteerKind = 'manual'): Step<HuntState, null> {
    const prev = s.roster[name]
    if (!prev) return [s, null]
    const fmt = (l: Lane) => `${l.source}/${l.strategy}`
    return [v(s, {
      roster: { ...s.roster, [name]: { ...prev, lane, laneChangedAt: now } },
      steers: [...s.steers, { at: now, scout: name, from: fmt(prev.lane), to: fmt(lane), reason, kind }].slice(-100),
    }), null]
  },

  setStatus(s: HuntState, status: HuntStatus): Step<HuntState, HuntStatus> {
    return [v(s, { status }), status]
  },

  setBudget(s: HuntState, usd: number): Step<HuntState, number> {
    const floor = s.spent + reserved(s)
    const budgetUsd = Math.max(usd, floor)
    const status = s.status === 'budget_exhausted' && budgetUsd > floor ? 'running' : s.status
    return [v(s, { input: { ...s.input!, budgetUsd }, status }), budgetUsd]
  },

  bump(s: HuntState, counter: keyof Counters, by = 1): Step<HuntState, number> {
    const n = (s.counters[counter] ?? 0) + by
    return [v(s, { counters: { ...s.counters, [counter]: n } }), n]
  },

  markFirstVerified(s: HuntState, now: number): Step<HuntState, null> {
    if (s.firstVerifiedAt !== null) return [s, null]
    return [v(s, { firstVerifiedAt: now, firstVerifiedSpend: s.spent }), null]
  },

  addCase(s: HuntState, caseId: string): Step<HuntState, null> {
    if (s.caseIds.includes(caseId)) return [s, null]
    return [v(s, { caseIds: [...s.caseIds, caseId] }), null]
  },

  recordSpawn(s: HuntState, spawn: Spawn): Step<HuntState, null> {
    return [v(s, { spawns: [...(s.spawns ?? []), spawn].slice(-100) }), null]
  },

  finishSpawn(s: HuntState, agent: string, caseId: string, outcome: string, now: number): Step<HuntState, null> {
    const spawns = (s.spawns ?? []).map(x => (x.agent === agent && x.caseId === caseId && !x.endedAt ? { ...x, endedAt: now, outcome } : x))
    return [v(s, { spawns }), null]
  },

  log(s: HuntState, text: string, now: number): Step<HuntState, null> {
    return [v(s, { events: [...s.events, { at: now, text }].slice(-MAX_EVENTS) }), null]
  },

  snapshot(s: HuntState): Step<HuntState, HuntState> {
    return [s, s]
  },
}
