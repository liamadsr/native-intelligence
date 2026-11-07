import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { applySuggestion } from '@/lib/suggestions/settle'

/**
 * POST /api/account/suggestions/[id]/apply — accept a suggestion, wherever it
 * is shown. Body `{ force?: true }` applies even though its target changed
 * since it was staged (409 `target_changed` otherwise). See settle.ts.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { force?: unknown }
  const result = await applySuggestion(auth.supabase, auth.user.id, id, { force: body.force === true })
  return NextResponse.json(result.body, { status: result.status })
}
