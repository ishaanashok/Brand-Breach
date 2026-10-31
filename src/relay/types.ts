export type BusMessage = { id: string; from: string; to: string; text: string }

export interface Participant {
  name: string
  /** `to` is '#channel' or '@handle'. */
  send(to: string, text: string): Promise<void>
}

export interface Bus {
  register(name: string): Promise<Participant>
  /** Every message in the workspace; callers filter on `to`. */
  onMessage(fn: (m: BusMessage) => void): () => void
  close(): Promise<void>
}

export const HUNT_CHANNEL = '#hunt'
export const REVIEW_CHANNEL = '#review'
