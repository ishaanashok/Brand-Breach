import { expect, test } from 'bun:test'
import { brand } from '../src/core/machines/brand'
import { kase } from '../src/core/machines/case'
import { hunt } from '../src/core/machines/hunt'
import { playbook } from '../src/core/machines/playbook'

// The file store calls the machines directly, so a method an actor lacks only fails on the real stack.
test('every case method runs through the brand', async () => {
  const source = await Bun.file(new URL('../src/actors.ts', import.meta.url).pathname).text()
  expect(source).toContain('(kase as Record<string, any>)[method]')
  expect(Object.keys(kase)).toContain('report')
})

test('every actor exposes every method of its machine', async () => {
  const source = await Bun.file(new URL('../src/actors.ts', import.meta.url).pathname).text()
  const classes = source.split('export class ').slice(1)
  const methods = (name: string) => new Set([...classes.find(c => c.startsWith(`${name} `))!.matchAll(/async (\w+)\(/g)].map(m => m[1]))
  const pairs: [string, object][] = [['Hunt', hunt], ['Brand', brand], ['Playbook', playbook]]
  for (const [name, machine] of pairs) {
    const have = methods(name)
    expect(Object.keys(machine).filter(k => !have.has(k))).toEqual([])
  }
})
