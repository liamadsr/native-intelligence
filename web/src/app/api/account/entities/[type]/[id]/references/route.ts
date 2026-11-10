/**
 * GET /api/account/entities/[type]/[id]/references — "Referenced in": the
 * things that link to one entity of any graph kind (a message or document
 * that @-mentions it, a task related to it), one row per source, newest first.
 *
 * `{ references: [{ type, id, label, relations, created_at, context }], count,
 * workspace_id }`. Reads on the session client (RLS is the fence): the entity
 * itself must be readable by the viewer (else 404), and a source they can't
 * read is left out (src/lib/entity-links/references.ts). Claims and mail are
 * never listed.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { LINKABLE_ENTITY_TYPES } from '@/lib/knowledge/entity-registry'
import { isMailSourceType } from '@/lib/knowledge/claim-visibility'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import { groupReferences, loadReferenceEdges } from '@/lib/entity-links/references'
import { isUuid } from '@/lib/work/touch'

export async function GET(_request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id: rawId } = await params
  if (!(LINKABLE_ENTITY_TYPES as readonly string[]).includes(type) || isMailSourceType(type)) {
    return badRequest('Unknown entity type')
  }
  if (!isUuid(rawId)) return badRequest('Invalid entity id')
  const id = rawId.toLowerCase()

  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  try {
    // The entity must be the viewer's to see: what links to someone else's
    // calendar event or a DM they're not in is not theirs to read either.
    const own = await resolveEntityLabels(supabase, workspaceId, new Map([[type, new Set([id])]]))
    if (!own.has(`${type}:${id}`)) return notFound()
  } catch (err) {
    console.error('[references] entity read failed:', type, id, err instanceof Error ? err.message : 'unknown')
    return serverError('Could not read what references this')
  }

  const loaded = await loadReferenceEdges(supabase, { workspaceId, type, id })
  if ('error' in loaded) {
    console.error('[references] read failed:', type, id, loaded.error)
    return serverError('Could not read what references this')
  }
  const references = groupReferences(loaded.edges, loaded.contexts)
  return NextResponse.json({ references, count: references.length, workspace_id: workspaceId })
}
