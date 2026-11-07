/**
 * Which entity an attention card is ABOUT, as columns (migration 280:
 * attention_item.entity_type / entity_id / capture_id). Pure: read from the
 * payload the card is inserted with, mirroring the migration's one-time
 * backfill so old and new rows agree.
 *
 *   - a proposal-backed card (action_card / draft_email / question from a
 *     decision) carries the proposal's entity_type + entity_id in its payload
 *     (cardPayload); those are the card's entity;
 *   - a work_proposal's SUBJECT is its task; its entity linkage exists only
 *     when a declared resource carries an id — the first such resource wins,
 *     'package' excluded (a package is context, not the subject);
 *   - capture_id is whatever provenance the payload carries.
 *
 * Only uuid-shaped ids are stamped; anything else stays NULL (the columns are
 * uuid, and a model-authored id must never fail the insert).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CardEntityRef {
  entityType: string | null
  entityId: string | null
  captureId: string | null
}

function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null
}

export function cardEntityRef(kind: string, payload: Record<string, unknown>): CardEntityRef {
  const captureId = uuidOrNull(payload.capture_id)

  const directId = uuidOrNull(payload.entity_id)
  const directType = typeof payload.entity_type === 'string' && payload.entity_type.trim() ? payload.entity_type.trim() : null
  if (directId && directType) return { entityType: directType, entityId: directId, captureId }

  if (kind === 'work_proposal' && Array.isArray(payload.resources)) {
    for (const entry of payload.resources) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const type = typeof e.type === 'string' ? e.type.trim() : ''
      const id = uuidOrNull(e.id)
      if (!type || type === 'package' || !id) continue
      return { entityType: type, entityId: id, captureId }
    }
  }

  return { entityType: null, entityId: null, captureId }
}
