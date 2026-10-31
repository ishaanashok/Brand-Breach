export const TAGS = ['ASSIGN', 'STEER', 'NEW', 'LEAD', 'REVIEW', 'DECISION'] as const
export type Tag = (typeof TAGS)[number]

export const encodeTag = (tag: Tag, payload: object) => `${tag} ${JSON.stringify(payload)}`

/** Relay text can carry anything, so junk parses to null and is ignored. */
export function parseTag(text: string): { tag: Tag; payload: any } | null {
  const i = text.indexOf(' ')
  if (i < 0) return null
  const tag = text.slice(0, i) as Tag
  if (!TAGS.includes(tag)) return null
  try {
    const payload = JSON.parse(text.slice(i + 1))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
    return { tag, payload }
  } catch {
    return null
  }
}
