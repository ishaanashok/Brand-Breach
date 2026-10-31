import { expect, test } from 'bun:test'
import { dirname, resolve } from 'node:path'

// The actor build type-checks without Bun's types, so one Bun global reachable from here stops the runtime.
test('code reachable from the actors file uses no Bun global', async () => {
  const seen = new Set<string>()
  const walk = async (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const src = await Bun.file(file).text()
    expect(src.match(/\bBun\.\w+/) ? file : null).toBeNull()
    for (const [, rel] of src.matchAll(/from '(\.[^']+)'/g)) {
      const base = resolve(dirname(file), rel!).replace(/\.js$/, '')
      await walk(`${base}.ts`)
    }
  }
  await walk(resolve(import.meta.dir, '../src/actors.ts'))
  expect(seen.size).toBeGreaterThan(3)
})
