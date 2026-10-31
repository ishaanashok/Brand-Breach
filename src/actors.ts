import { Actor, Ephemeral, Persisted } from 'durable-actors'
import { brand, initialBrand, type BrandState, type Edge, type Label, type LaneStat, type PageMemory, type SearchRecord } from './core/machines/brand.js'
import { kase, initialCase, type CaseState, type DecisionRecord, type Reasoning, type Verification } from './core/machines/case.js'
import { hunt, initialHunt, type Counters, type HuntState, type HuntStatus, type ReserveResult, type Spawn, type SteerKind } from './core/machines/hunt.js'
import type { KbEntity } from './core/kb.js'
import { playbook, initialPlaybook, type PlaybookState } from './core/machines/playbook.js'
import type { Hit, HuntInput, Lane } from './core/types.js'

// Actors only hold state and apply rules from the machines; they never call a model.
// Each method reassigns `s` whole because nested mutations are not persisted.

export class Hunt extends Actor {
  @Persisted s: HuntState = initialHunt()
  #run<R>([next, r]: [HuntState, R]): R { this.s = next; return r }

  async init(id: string, input: HuntInput, now: number, mode = ''): Promise<HuntState> { return this.#run(hunt.init(this.s, id, input, now, mode)) }
  async reserve(scout: string, usd: number, now: number): Promise<ReserveResult> { return this.#run(hunt.reserve(this.s, scout, usd, now)) }
  async settle(id: string, actualUsd: number): Promise<{ spent: number }> { return this.#run(hunt.settle(this.s, id, actualUsd)) }
  async registerScout(name: string, lane: Lane, now: number): Promise<Lane> { return this.#run(hunt.registerScout(this.s, name, lane, now)) }
  async setScoutStatus(name: string, status: string, now: number): Promise<null> { return this.#run(hunt.setScoutStatus(this.s, name, status, now)) }
  async setLane(name: string, lane: Lane, reason: string, now: number, kind?: SteerKind): Promise<null> { return this.#run(hunt.setLane(this.s, name, lane, reason, now, kind)) }
  async setStatus(status: HuntStatus): Promise<HuntStatus> { return this.#run(hunt.setStatus(this.s, status)) }
  async setBudget(usd: number): Promise<number> { return this.#run(hunt.setBudget(this.s, usd)) }
  async bump(counter: keyof Counters, by = 1): Promise<number> { return this.#run(hunt.bump(this.s, counter, by)) }
  async markFirstVerified(now: number): Promise<null> { return this.#run(hunt.markFirstVerified(this.s, now)) }
  async addCase(caseId: string): Promise<null> { return this.#run(hunt.addCase(this.s, caseId)) }
  async recordSpawn(spawn: Spawn): Promise<null> { return this.#run(hunt.recordSpawn(this.s, spawn)) }
  async finishSpawn(agent: string, caseId: string, outcome: string, now: number): Promise<null> { return this.#run(hunt.finishSpawn(this.s, agent, caseId, outcome, now)) }
  async log(text: string, now: number): Promise<null> { return this.#run(hunt.log(this.s, text, now)) }
  async adopt(state: HuntState): Promise<boolean> {
    if (this.s.input) return false
    this.s = state
    return true
  }
  async snapshot(): Promise<HuntState> { return this.s }
}

/**
 * One actor for each brand, holding everything learned about it across hunts: its knowledge base, every page
 * and how it was judged, the links between them, and each search and how it went. Pages, links and searches
 * are table rows, because a hunt writes hundreds and each write should only touch its own row.
 */
export class Brand extends Actor {
  @Persisted s: BrandState = initialBrand()
  @Ephemeral tablesReady = false
  #run<R>([next, r]: [BrandState, R]): R { this.s = next; return r }

  #tables() {
    if (this.tablesReady) return
    this.tablesReady = true
    this.db.exec('CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, json TEXT NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, json TEXT NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS edges (key TEXT PRIMARY KEY, json TEXT NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS searches (n INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)')
    // A brand from before these tables keeps its history.
    if (Object.keys(this.s.seen ?? {}).length || this.s.edges?.length) {
      for (const [url, page] of Object.entries(this.s.seen ?? {})) this.#savePage(url, page)
      for (const e of this.s.edges ?? []) this.#saveEdge(e)
      this.s = { ...this.s, seen: {}, edges: [] }
    }
  }
  #savePage(url: string, page: PageMemory) { this.db.exec('INSERT OR REPLACE INTO pages (url, json) VALUES (?, ?)', url, JSON.stringify(page)) }
  #saveEdge(e: Edge) { return this.db.exec('INSERT OR IGNORE INTO edges (key, json) VALUES (?, ?) RETURNING key', `${e.from}|${e.to}|${e.kind}`, JSON.stringify(e)).length }
  #page(url: string): PageMemory | null {
    this.#tables()
    const row = this.db.exec<{ json: string }>('SELECT json FROM pages WHERE url = ?', url)[0]
    return row ? JSON.parse(row.json) : null
  }
  /** Runs a machine step over just this page, and saves just this page. */
  #pageStep<R>(url: string, step: (s: BrandState) => [BrandState, R]): R {
    const known = this.#page(url)
    const [next, r] = step({ ...this.s, seen: known ? { [url]: known } : {} })
    if (next.seen[url] && next.version !== this.s.version) {
      this.#savePage(url, next.seen[url]!)
      this.s = { ...this.s, version: next.version }
    }
    return r
  }
  #case(id: string): CaseState {
    this.#tables()
    const row = this.db.exec<{ json: string }>('SELECT json FROM cases WHERE id = ?', id)[0]
    return row ? JSON.parse(row.json) : initialCase()
  }

  /** Every case method, on the case it names. Calls still run one at a time, so a case keeps its guarantees. */
  async caseCall(id: string, method: string, args: unknown[]): Promise<unknown> {
    const before = this.#case(id)
    const [next, r] = (kase as Record<string, any>)[method](before, ...args) as [CaseState, unknown]
    if (next !== before) this.db.exec('INSERT OR REPLACE INTO cases (id, json) VALUES (?, ?)', id, JSON.stringify(next))
    return r
  }
  async caseSnapshots(ids: string[]): Promise<CaseState[]> { return ids.map(id => this.#case(id)) }
  async someCases(limit: number): Promise<CaseState[]> {
    this.#tables()
    return this.db.exec<{ json: string }>(`SELECT json FROM cases ORDER BY json_extract(json, '$.state') IN ('verified', 'awaiting_approval', 'approved') DESC, id LIMIT ?`, limit).map(r => JSON.parse(r.json))
  }
  /** Brings in cases kept elsewhere. A case already here wins, so an import can run again safely. */
  async adoptCases(cases: CaseState[]): Promise<number> {
    this.#tables()
    return cases.reduce((n, c) => n + this.db.exec('INSERT OR IGNORE INTO cases (id, json) VALUES (?, ?) RETURNING id', c.id, JSON.stringify(c)).length, 0)
  }
  async adopt(source: string, other: BrandState): Promise<boolean> {
    this.#tables()
    for (const [url, page] of Object.entries(other.seen ?? {})) {
      this.db.exec('INSERT OR IGNORE INTO pages (url, json) VALUES (?, ?)', url, JSON.stringify(page))
    }
    for (const e of other.edges ?? []) this.#saveEdge(e)
    return this.#run(brand.adopt(this.s, source, other))
  }

  async configure(slug: string, officialDomains: string[], authorizedSellers: string[]): Promise<BrandState> { return this.#run(brand.configure(this.s, slug, officialDomains, authorizedSellers)) }
  async addEdges(edges: Edge[]): Promise<number> {
    this.#tables()
    const added = edges.reduce((n, e) => n + this.#saveEdge(e), 0)
    if (added) this.s = { ...this.s, version: this.s.version + 1 }
    return added
  }
  async recordLaneOutcome(lane: string, d: LaneStat): Promise<LaneStat> { return this.#run(brand.recordLaneOutcome(this.s, lane, d)) }
  async addLabel(l: Label): Promise<boolean> { return this.#run(brand.addLabel(this.s, l)) }
  async markSeen(url: string, r: { score: number; state: string }, huntId = '', now = 0): Promise<null> { return this.#pageStep(url, s => brand.markSeen(s, url, r, huntId, now)) }
  async getSeen(url: string): Promise<PageMemory | null> { return this.#page(url) }
  async notePage(url: string, huntId: string, now: number): Promise<boolean> { return this.#pageStep(url, s => brand.notePage(s, url, huntId, now)) }
  async recordSearch(r: SearchRecord): Promise<null> {
    this.#tables()
    this.db.exec('INSERT INTO searches (json) VALUES (?)', JSON.stringify(r))
    return null
  }
  /** For rule checks on hot paths, which don't need every page this brand has ever seen. */
  async summary(): Promise<BrandState> {
    this.#tables()
    return brand.summary(this.s)[1]
  }
  async setKb(entities: KbEntity[], builtBy: string, now: number): Promise<number> { return this.#run(brand.setKb(this.s, entities, builtBy, now)) }
  async addKbEntity(e: KbEntity): Promise<null> { return this.#run(brand.addKbEntity(this.s, e)) }
  async removeKbEntity(id: string): Promise<null> { return this.#run(brand.removeKbEntity(this.s, id)) }
  async getThreshold(deciderId: string): Promise<number> { return this.#run(brand.getThreshold(this.s, deciderId)) }
  async getLaneStats(): Promise<Record<string, LaneStat>> { return this.#run(brand.getLaneStats(this.s)) }
  async snapshot(): Promise<BrandState> {
    this.#tables()
    const rows = (table: string, order: string) => this.db.exec<Record<string, string>>(`SELECT * FROM ${table} ORDER BY ${order}`)
    const seen: BrandState['seen'] = {}
    for (const r of rows('pages', 'url')) seen[r.url!] = JSON.parse(r.json!)
    return {
      ...this.s,
      seen,
      edges: rows('edges', 'key').map(r => JSON.parse(r.json!)),
      searches: rows('searches', 'n').map(r => JSON.parse(r.json!)),
    }
  }
}

export class Playbook extends Actor {
  @Persisted s: PlaybookState = initialPlaybook()
  #run<R>([next, r]: [PlaybookState, R]): R { this.s = next; return r }

  async update(lane: string, d: LaneStat): Promise<null> { return this.#run(playbook.update(this.s, lane, d)) }
  async getPriors(): Promise<Record<string, LaneStat>> { return this.#run(playbook.getPriors(this.s)) }
  async registerHunt(id: string): Promise<null> { return this.#run(playbook.registerHunt(this.s, id)) }
  async listHunts(): Promise<string[]> { return this.#run(playbook.listHunts(this.s)) }
  async adopt(source: string, other: PlaybookState): Promise<boolean> { return this.#run(playbook.adopt(this.s, source, other)) }
  async getCommentary(): Promise<string[]> { return this.#run(playbook.getCommentary(this.s)) }
  async addCommentary(raw: string): Promise<boolean> { return this.#run(playbook.addCommentary(this.s, raw)) }
  async removeCommentary(entry: string): Promise<null> { return this.#run(playbook.removeCommentary(this.s, entry)) }
  async snapshot(): Promise<PlaybookState> { return this.s }
}
