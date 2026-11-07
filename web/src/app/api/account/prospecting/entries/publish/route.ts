/**
 * POST /api/account/prospecting/entries/publish — promotion, for SPECIFIC
 * entries (migration 259).
 *
 * Publish is the ONLY thing that writes to the CRM. The list-level button
 * uses `lists/[id]/publish`; this route is for the two callers that need
 * particular entries in the CRM right now:
 *
 *   - the per-row `needs_review` confirm, which publishes THAT ONE person
 *     with `include_unverified` (never a bulk default — the flag is the
 *     namesake gate's per-row escape hatch, and a batch that carried it would
 *     be the gate with a bypass button);
 *   - Add-to-sequence, which needs contact ids and cannot enroll a person who
 *     is only on the list.
 *
 * PER-ENTRY OUTCOMES, never a count:
 *
 *   { saved: [{entry_id, list_id, kind, company_id?, contact_id?, email?}],
 *     skipped: [{entry_id, list_id, reason, message?}],
 *     list_ids, published_at }
 *
 * A 200 with an empty `saved` and a full `skipped` is the CORRECT response to
 * "none of these could be published" — the reasons are the answer.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { publishEntries } from '@/lib/prospecting/publish'

const MAX_ENTRIES_PER_PUBLISH = 100

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const includeUnverified = body.include_unverified === true

  const raw = body.entry_ids
  if (!Array.isArray(raw)) return badRequest('entry_ids must be an array')
  const entryIds = raw.filter((v): v is string => typeof v === 'string' && v !== '')
  if (entryIds.length === 0) return badRequest('entry_ids must contain at least one id')
  if (entryIds.length > MAX_ENTRIES_PER_PUBLISH) {
    return apiError(`Publish at most ${MAX_ENTRIES_PER_PUBLISH} entries at a time`, {
      status: 400,
      code: 'TOO_MANY_ENTRIES',
    })
  }

  const result = await publishEntries(supabase, {
    workspaceId,
    userId: user.id,
    entryIds,
    includeUnverified,
  })
  if (!result.ok) return serverError()

  return NextResponse.json({
    saved: result.saved,
    skipped: result.skipped,
    list_ids: result.list_ids,
    published_at: result.published_at,
  })
}
