/**
 * An approval card's inputs, as the card shows them (A5: what the person sees
 * is what runs). Pure and client-safe.
 *
 * Every field of the stored input is listed, keys sorted with the
 * target-like ones first (who or what the call acts on: to, recipient,
 * email, url, project, team, id), then alphabetically. Values are shown
 * whole; the card clips a long one per field, behind an expand.
 */

/** Target-like keys, in the order they lead. */
export const APPROVAL_TARGET_KEYS = ['to', 'recipient', 'recipients', 'email', 'url', 'project', 'team', 'id'] as const

/** A field's value longer than this is clipped on the card until expanded. */
export const APPROVAL_FIELD_CLIP_CHARS = 280

export interface ApprovalInputField {
  key: string
  /** The whole value, as text (a string as is; anything else as indented JSON). */
  value: string
  /** One of the target-like keys (they lead, and the card marks them). */
  target: boolean
}

/** Where a key ranks among the target-like keys, or -1. */
function targetRank(key: string): number {
  const k = key.toLowerCase()
  return APPROVAL_TARGET_KEYS.findIndex((t) => k === t || k.startsWith(`${t}_`) || k.endsWith(`_${t}`) || (t === 'id' && k.endsWith('_ids')) || k === `${t}s`)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Every field of an approval's stored input, target-like keys first. */
export function approvalInputFields(input: unknown): ApprovalInputField[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input === undefined || input === null ? [] : [{ key: 'input', value: asText(input), target: false }]
  }
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => ({ key, value: asText(value), rank: targetRank(key) }))
    .sort((a, b) => {
      const ra = a.rank < 0 ? Number.MAX_SAFE_INTEGER : a.rank
      const rb = b.rank < 0 ? Number.MAX_SAFE_INTEGER : b.rank
      return ra !== rb ? ra - rb : a.key.localeCompare(b.key)
    })
    .map(({ key, value, rank }) => ({ key, value, target: rank >= 0 }))
}
