import { AgentRelay } from '@agent-relay/sdk'
import { HUNT_CHANNEL, REVIEW_CHANNEL, type Bus, type BusMessage, type Participant } from './types'

const name = (c: string) => c.replace(/^#/, '')

/**
 * Real Agent Relay. The workspace key is the caller's to persist so a restart rejoins the same room.
 * Registered participants fan in to `addListener`, per SDK 14; there is no `workspace.stream` to enable.
 */
export async function relayBus(o: { workspaceKey?: string; workspaceName: string; onKey?: (k: string) => void }): Promise<Bus> {
  const relay: any = o.workspaceKey
    ? new AgentRelay({ workspaceKey: o.workspaceKey })
    : await AgentRelay.createWorkspace({ name: o.workspaceName })
  if (relay.workspaceKey) o.onKey?.(relay.workspaceKey)

  const seen = new Set<string>()
  const listeners = new Set<(m: BusMessage) => void>()
  // The listener is shared, so one message arrives once per registered agent that can see it.
  const emit = (to: (e: any) => string) => (event: any) => {
    const { message, envelope } = event
    const id = message.messageId ?? message.id
    if (seen.has(id)) return
    seen.add(id)
    const m = { id, from: envelope.from?.handle?.replace(/^@/, '') ?? 'unknown', to: to(event), text: message.text }
    for (const l of listeners) l(m)
  }
  relay.addListener('message.created', emit(({ envelope }) => `#${envelope.channel?.name}`))
  relay.addListener('dm.received', emit(({ envelope }) => {
    const t = envelope.to
    return `@${String(t?.handle ?? t?.name ?? t).replace(/^@/, '')}`
  }))

  let channelsReady = false
  return {
    async register(agentName): Promise<Participant> {
      const agent = await relay.workspace.register({ name: agentName, type: 'agent' })
      if (!channelsReady) {
        channelsReady = true
        for (const c of [HUNT_CHANNEL, REVIEW_CHANNEL]) await agent.channels.create({ name: name(c), topic: 'Customs' }).catch(() => {})
      }
      for (const c of [HUNT_CHANNEL, REVIEW_CHANNEL]) await agent.channels.join(name(c)).catch(() => {})
      return { name: agentName, send: async (to, text) => { await agent.sendMessage({ to, text }) } }
    },
    onMessage(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async close() { listeners.clear() },
  }
}
