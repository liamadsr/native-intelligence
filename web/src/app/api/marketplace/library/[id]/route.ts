import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { MARKETPLACE_DETAIL_FIELDS } from '@/lib/library/queries'

/**
 * View a single public marketplace item (skill, agent, or meeting type).
 * Only public, non-system items are accessible here — fork to use.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { id } = await params

  const { data, error } = await supabase
    .from('recipe')
    .select(MARKETPLACE_DETAIL_FIELDS)
    .eq('id', id)
    .eq('visibility', 'public')
    .eq('is_system', false)
    .single()

  if (error || !data) return notFound('Library item not found')
  return NextResponse.json({ item: data })
}
