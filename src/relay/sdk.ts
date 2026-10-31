import { AgentRelay } from '@agent-relay/sdk'
import { HUNT_CHANNEL, REVIEW_CHANNEL, type Bus, type BusMessage, type Participant } from './types'

const name = (c: string) => c.replace(/^#/, '')

/** Relay sheds load with retryable errors, and says how long to wait when it knows. */
export async function withBackoff<T>(fn: () => Promise<T>, tries = 8, baseMs = 250): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (err: any) {
      const busy = err?.retryable === true || /retry with backoff|capacity is busy/i.test(String(err))
      if (i >= tries || !busy) throw err
      await Bun.sleep(err?.retryAfterMs ?? baseMs * 2 ** (i - 1) * (0.5 + Math.random()))
    }
  }
}

/**
 * A dm.received event names no recipient, and one listener hears every agent's DMs,
 * so the bus addresses DMs in the text and removes the address on arrival.
 */
export const addressDm = (to: string, text: string) => `[to:${to.replace(/^@/, '')}] ${text}`
export function readDm(raw: string): { to: string; text: string } {
  const m = raw.match(/^\[to:([^\]]+)\] ([\s\S]*)$/)
  return m ? { to: `@${m[1]}`, text: m[2]! } : { to: '@unknown', text: raw }
}

export type RelayState = { workspaceKey?: string; tokens: Record<string, string> }

export async function relayBus(o: { workspaceName: string; state: RelayState; save: (s: RelayState) => void }): Promise<Bus> {
  const state = o.state
  const relay: any = state.workspaceKey
    ? new AgentRelay({ workspaceKey: state.workspaceKey })
    : await withBackoff(() => AgentRelay.createWorkspace({ name: o.workspaceName }))
  if (relay.workspaceKey) state.workspaceKey = relay.workspaceKey
  o.save(state)

  const seen = new Set<string>()
  const listeners = new Set<(m: BusMessage) => void>()
  // The listener is shared, so one message arrives once per registered agent that can see it.
  const emit = (read: (e: any) => { to: string; text: string }) => (event: any) => {
    const { message, envelope } = event
    const id = message.messageId ?? message.id
    if (seen.has(id)) return
    seen.add(id)
    const f = envelope.from
    const m = { id, from: String(f?.name ?? f?.handle ?? 'unknown').replace(/^@/, ''), ...read(event) }
    for (const l of listeners) l(m)
  }
  relay.addListener('message.created', emit(({ envelope, message }) => ({ to: `#${envelope.channel?.name}`, text: message.text })))
  relay.addListener('dm.received', emit(({ message }) => readDm(message.text)))

  let channelsReady = false
  return {
    async register(agentName): Promise<Participant> {
      // Relay refuses a second register for a name, so a restarted server reconnects with the saved token.
      const saved = state.tokens[agentName]
      const agent: any = saved
        ? await withBackoff(() => relay.workspace.reconnect({ apiToken: saved }))
        : await withBackoff(() => relay.workspace.register({ name: agentName, type: 'agent' }))
      if (agent.token) { state.tokens[agentName] = agent.token; o.save(state) }
      if (!channelsReady) {
        channelsReady = true
        for (const c of [HUNT_CHANNEL, REVIEW_CHANNEL]) await withBackoff(() => agent.channels.create({ name: name(c), topic: 'Customs' })).catch(() => {})
      }
      for (const c of [HUNT_CHANNEL, REVIEW_CHANNEL]) await withBackoff(() => agent.channels.join(name(c))).catch(() => {})
      return { name: agentName, send: async (to, text) => { await withBackoff(() => agent.sendMessage({ to, text: to.startsWith('@') ? addressDm(to, text) : text })) } }
    },
    onMessage(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async close() { listeners.clear() },
  }
}
