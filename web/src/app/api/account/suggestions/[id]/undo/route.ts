import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { undoSuggestion } from '@/lib/suggestions/settle'

/** POST /api/account/suggestions/[id]/undo — un-apply an accepted create (settle.ts). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  const result = await undoSuggestion(auth.supabase, auth.user.id, id)
  return NextResponse.json(result.body, { status: result.status })
}
