import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { editSuggestion } from '@/lib/suggestions/settle'

/** PATCH /api/account/suggestions/[id] — modify a suggestion before (or after) accepting it (settle.ts). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return badRequest('Expected a JSON object')
  const result = await editSuggestion(auth.supabase, auth.user.id, id, body as Record<string, unknown>)
  return NextResponse.json(result.body, { status: result.status })
}
