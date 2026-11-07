/**
 * POST /api/account/sequences/[id]/enroll — stage contacts into a sequence.
 *
 * The staging semantics and per-contact guards (skip reasons not_found /
 * no_email / suppressed / already_active, both-uniques awareness, inert
 * active-with-NULL-next_send_at inserts) live in the shared implementation —
 * src/lib/sequences/mutations.ts `enrollContacts` — which also backs the
 * enroll_contacts_in_sequence AI agent tool. This route is the thin HTTP
 * mapping over it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { enrollContacts } from '@/lib/sequences/mutations'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const contactIds = Array.isArray(body.contact_ids)
    ? (body.contact_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  if (contactIds.length === 0) return badRequest('contact_ids must be a non-empty array')

  const result = await enrollContacts(supabase, {
    workspaceId,
    sequenceId: id,
    enrolledBy: user.id,
    contactIds,
  })
  if (!result.ok) {
    if (result.code === 'sequence_not_found') return notFound('Sequence not found')
    if (result.code === 'sequence_archived') {
      return badRequest('Cannot enroll into an archived sequence')
    }
    return serverError()
  }

  return NextResponse.json({ enrolled: result.enrolled, skipped: result.skipped })
}
