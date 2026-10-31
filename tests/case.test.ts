import { expect, test } from 'bun:test'
import { kase, initialCase, type CaseState } from '../src/core/machines/case'
import { brand, initialBrand } from '../src/core/machines/brand'
import { playbook, initialPlaybook } from '../src/core/machines/playbook'

const hit = { url: 'https://a.example/x', surface: 'video' as const, title: 't', snippet: 's' }
const reported = (): CaseState => kase.report(initialCase(), 'c1', 'tesla', 'h1', hit, 'video', 1)[0]
const triage = { answers: [], deciderId: 'mock', usd: 0, latencyMs: 1, score: 0.9, confidence: 0.8, why: 'looks like a scam' }

test('first reporter wins and duplicates are recorded', () => {
  const [a, r1] = kase.report(initialCase(), 'c1', 'tesla', 'h1', hit, 'video', 1)
  const [b, r2] = kase.report(a, 'c1', 'tesla', 'h1', hit, 'social', 2)
  expect(r1.first).toBe(true)
  expect(r2.first).toBe(false)
  expect(b.reporters).toEqual(['video', 'social'])
})

test('walks the full state path to a simulated submit', () => {
  let s = kase.setTriage(reported(), triage)[0]
  expect(s.state).toBe('triaged')
  s = kase.shortlist(s)[0]
  expect(s.state).toBe('shortlisted')
  s = kase.setVerification(s, { ...triage, verified: true, score: 0.95 })[0]
  expect(s.state).toBe('verified')
  s = kase.draftNotice(s, 'Dear platform')[0]
  expect(s.state).toBe('awaiting_approval')
  const [d, r] = kase.decide(s, 'approve', 'ash', 5)
  expect(r.changed).toBe(true)
  expect(d.state).toBe('approved')
  expect(d.approval).toMatchObject({ decision: 'approve', by: 'ash', simulatedSubmit: true })
})

test('the first decision stands', () => {
  let s = kase.draftNotice(kase.setVerification(kase.shortlist(kase.setTriage(reported(), triage)[0])[0], { ...triage, verified: true })[0], 'n')[0]
  s = kase.decide(s, 'approve', 'ash', 5)[0]
  const [n, r] = kase.decide(s, 'reject', 'ash', 6)
  expect(r.changed).toBe(false)
  expect(n.state).toBe('approved')
})

test('a case cannot be decided before a notice exists', () => {
  const [s, r] = kase.decide(reported(), 'approve', 'ash', 5)
  expect(r.changed).toBe(false)
  expect(s.state).toBe('new')
})

test('verification that clears a candidate closes it without a notice', () => {
  const s = kase.setVerification(kase.shortlist(kase.setTriage(reported(), triage)[0])[0], { ...triage, verified: false })[0]
  expect(s.state).toBe('cleared')
})

test('all deciders failing leaves the case undecided for a human', () => {
  expect(kase.markUndecided(reported(), 'all deciders failed')[0].state).toBe('undecided')
})

test('brand edges dedupe, lane stats correct provisional rewards', () => {
  let b = initialBrand()
  b = brand.addEdges(b, [{ from: 'seller:x', to: 'domain:y', kind: 'lead' }, { from: 'seller:x', to: 'domain:y', kind: 'lead' }])[0]
  expect(b.edges).toHaveLength(1)
  b = brand.recordLaneOutcome(b, 'video/giveaway', { tries: 1, hits: 0.8, costUsd: 0.01 })[0]
  b = brand.recordLaneOutcome(b, 'video/giveaway', { tries: 0, hits: 0.2, costUsd: 0 })[0]
  expect(b.laneStats['video/giveaway']).toEqual({ tries: 1, hits: 1, costUsd: 0.01 })
})

test('labels tune thresholds per decider and rejected sellers are not whitelisted twice', () => {
  let b = initialBrand()
  const t0 = brand.getThreshold(b, 'laya-local')[1]
  b = brand.addLabel(b, { caseId: 'a', url: 'u', decision: 'reject', deciderId: 'laya-local', score: 0.7, seller: 'good-shop' })[0]
  b = brand.addLabel(b, { caseId: 'a', url: 'u', decision: 'reject', deciderId: 'laya-local', score: 0.7, seller: 'good-shop' })[0]
  expect(b.labels).toHaveLength(1)
  expect(brand.getThreshold(b, 'laya-local')[1]).toBeGreaterThan(t0)
  expect(brand.getThreshold(b, 'openai-decisions')[1]).toBe(t0)
  expect(b.whitelist).toEqual(['good-shop'])
})

test('seen log tells a later hunt what it already covered', () => {
  let b = initialBrand()
  b = brand.markSeen(b, 'https://a.example/x', { score: 0.9, state: 'verified' })[0]
  expect(brand.getSeen(b, 'https://a.example/x')[1]).toMatchObject({ score: 0.9 })
  expect(brand.getSeen(b, 'https://b.example')[1]).toBeNull()
})

test('playbook keeps source and strategy only', () => {
  const [p] = playbook.update(initialPlaybook(), 'video/giveaway', { tries: 1, hits: 1, costUsd: 0.1 })
  expect(JSON.stringify(p.priors)).not.toContain('tesla')
  expect(playbook.update(p, 'tesla scam query', { tries: 1, hits: 1, costUsd: 0 })[0].priors).toEqual(p.priors)
  expect(playbook.getPriors(p)[1]['video/giveaway']!.hits).toBe(1)
})

test('playbook lists active hunts so a restarted server can resume them', () => {
  let p = playbook.registerHunt(initialPlaybook(), 'h1')[0]
  p = playbook.registerHunt(p, 'h1')[0]
  expect(playbook.listHunts(p)[1]).toEqual(['h1'])
  expect(playbook.listHunts(playbook.forgetHunt(p, 'h1')[0])[1]).toEqual([])
})
