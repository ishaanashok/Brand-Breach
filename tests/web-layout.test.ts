import { expect, test } from 'bun:test'

const file = '../public/web.js'
await import(file)
const createLayout = (globalThis as any).WebLayout

const surfaces = ['social', 'marketplace', 'video', 'domains', 'channels']
const ids = Array.from({ length: 200 }, (_, i) => `case_${i}`)
const placeAll = (seed: string) => {
  const layout = createLayout(seed)
  return { layout, knots: ids.map((id, i) => layout.place(id, surfaces[i % 5])) }
}

test('a hunt lays out the same way every time it is opened', () => {
  const coords = (seed: string) => placeAll(seed).knots.map((k: any) => [k.x, k.y])
  expect(coords('hunt_a')).toEqual(coords('hunt_a'))
  expect(coords('hunt_a')).not.toEqual(coords('hunt_b'))
})

test('every listing gets its own junction, even past the first rings', () => {
  const { knots } = placeAll('hunt_a')
  expect(new Set(knots.map((k: any) => k.id)).size).toBe(ids.length)
})

test('a listing sits in the part of the web for where it was found', () => {
  const { layout, knots } = placeAll('hunt_a')
  knots.forEach((k: any, i: number) => expect(layout.radials[k.radial].surface).toBe(surfaces[i % 5]))
  expect(layout.radials[createLayout('x').place('c', 'unknown-surface').radial]).toBeDefined()
})

test('one busy surface spreads over the whole web instead of leaving part of it bare', () => {
  const layout = createLayout('hunt_a')
  const knots = Array.from({ length: 400 }, (_, i) => layout.place(`case_${i}`, 'marketplace'))
  const used = new Set(knots.map((k: any) => layout.radials[k.radial].surface))
  expect(used.size).toBe(5)
  expect(new Set(knots.map((k: any) => k.id)).size).toBe(400)
})

test('spiders run from green to red as the risk rises', () => {
  const color = (globalThis as any).WebRiskColor
  expect(color(0.5)).toBe('hsl(120 85% 55%)')
  expect(color(0.75)).toBe('hsl(60 85% 55%)')
  expect(color(1)).toBe('hsl(0 85% 55%)')
})
