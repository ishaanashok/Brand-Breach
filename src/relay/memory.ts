import type { Bus, BusMessage, Participant } from './types'

/** In-process bus for tests and offline runs; same interface as real Relay. */
export class MemoryBus implements Bus {
  private listeners = new Set<(m: BusMessage) => void>()
  private n = 0
  log: BusMessage[] = []

  async register(name: string): Promise<Participant> {
    return {
      name,
      send: async (to, text) => {
        const m = { id: `m${++this.n}`, from: name, to, text }
        this.log.push(m)
        // Delivered on a later tick, like a network.
        queueMicrotask(() => { for (const l of this.listeners) l(m) })
      },
    }
  }

  onMessage(fn: (m: BusMessage) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  async close() { this.listeners.clear() }
}
