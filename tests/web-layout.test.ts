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
  const hue = (s: number) => Number(color(s).match(/\d+/)[0])
  expect(hue(0.5)).toBe(125)
  expect(hue(1)).toBe(0)
  // Real flagged scores bunch up above 90%, and each point there still has to look different.
  for (const s of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.96, 0.97, 0.98, 0.99]) expect(hue(s)).toBeGreaterThan(hue(s + 0.01))
  expect((globalThis as any).WebPaleRiskColor(1)).toBe('hsl(0 70% 82%)')
})

test('the Rolex knowledge graph is the same every time and has no loose links', async () => {
  await import('../public/kb-data.js' as string)
  const { buildGraph, LINKS } = (globalThis as any).RolexKb
  const a = buildGraph()
  expect(buildGraph()).toEqual(a)
  const ids = new Set(a.nodes.map((n: any) => n.id))
  expect(ids.size).toBe(a.nodes.length)
  expect(LINKS.filter(([x, y]: string[]) => !ids.has(x) || !ids.has(y))).toEqual([])
  expect(a.nodes.length).toBeGreaterThan(150)
})

test('every Rolex reference image is in the project', async () => {
  await import('../public/kb-data.js' as string)
  const images = (globalThis as any).RolexKb.GATHER.find((s: any) => s.kind === 'images').items
  expect(images).toHaveLength(5)
  for (const i of images) expect(await Bun.file(new URL(`../public/${i.src}`, import.meta.url).pathname).exists()).toBe(true)
})
