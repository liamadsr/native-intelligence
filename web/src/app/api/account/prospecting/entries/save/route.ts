/**
 * POST /api/account/prospecting/entries/save — keep entries ON THE LIST.
 *
 * Save is CURATION (Liam, 2026-09-06). It marks the entries `saved`, with the
 * cascades `updateEntryStage` documents (a company keeps its people, a person
 * keeps its company), and it never writes to the CRM. That is
 * `entries/publish` — and, for a whole list, `lists/[id]/publish`.
 *
 * The response keeps Publish's shape — PER-ENTRY OUTCOMES, never a count:
 *
 *   { saved: [{entry_id, list_id, kind, company_id?, contact_id?}],
 *     skipped: [{entry_id, list_id, reason, message?}] }
 *
 * so the page reconciles a Save and a Publish with one loop. A 200 with
 * refusals in `skipped` is the correct answer to "some of these could not be
 * saved"; the reasons are the information.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { saveEntriesToList } from '@/lib/prospecting/lists'

/** A stage write and a cascade per entry — bounded so one press cannot run
 *  long. The selection bar and Scout both cap at this. */
const MAX_ENTRIES_PER_SAVE = 100

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

  const raw = body.entry_ids
  if (!Array.isArray(raw)) return badRequest('entry_ids must be an array')
  const entryIds = raw.filter((v): v is string => typeof v === 'string' && v !== '')
  if (entryIds.length === 0) return badRequest('entry_ids must contain at least one id')
  if (entryIds.length > MAX_ENTRIES_PER_SAVE) {
    // apiError, not badRequest(msg, {code}) — badRequest's second argument is
    // `details`, which would bury the code and leave the envelope's own `code`
    // as the generic 'BAD_REQUEST'.
    return apiError(`Save at most ${MAX_ENTRIES_PER_SAVE} entries at a time`, {
      status: 400,
      code: 'TOO_MANY_ENTRIES',
    })
  }

  const result = await saveEntriesToList(supabase, { workspaceId, userId: user.id, entryIds })
  if (!result.ok) return serverError()

  return NextResponse.json({ saved: result.saved, skipped: result.skipped })
}
