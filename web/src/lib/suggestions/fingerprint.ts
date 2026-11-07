import { createHash } from 'node:crypto'

/**
 * A suggestion's identity for dedup: the same change to the same target with
 * the same proposed values is the same suggestion, wherever it was staged.
 * Proposing a different due date is a different suggestion.
 */
export interface FingerprintFacts {
  workspaceId: string
  changeType: string
  entityType: string
  /** The target's id; for a create, the normalized title stands in. */
  entityId?: string | null
  title?: string | null
  /** The proposed values (status, assignee id, due date, …). */
  values: Record<string, string | number | null | undefined>
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function suggestionFingerprint(f: FingerprintFacts): string {
  const values = Object.keys(f.values)
    .filter((k) => norm(f.values[k]) !== '')
    .sort()
    .map((k) => `${k}=${norm(f.values[k])}`)
  const subject = f.entityId ? `id:${f.entityId}` : `title:${norm(f.title)}`
  const key = [f.workspaceId, f.changeType, f.entityType, subject, ...values].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}
