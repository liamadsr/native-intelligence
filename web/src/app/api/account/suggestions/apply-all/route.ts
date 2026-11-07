import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { applySuggestions } from '@/lib/suggestions/settle'

const MAX_IDS = 50

/**
 * POST /api/account/suggestions/apply-all — body `{ ids }`. Accepts each in
 * order; one that's no longer pending or whose target changed is skipped and
 * reported, never forced (settle.ts).
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((x): x is string => typeof x === 'string') : []
  if (ids.length === 0) return badRequest('ids is required')
  if (ids.length > MAX_IDS) return badRequest(`At most ${MAX_IDS} ids`)
  const result = await applySuggestions(auth.supabase, auth.user.id, ids)
  return NextResponse.json(result.body, { status: result.status })
}
