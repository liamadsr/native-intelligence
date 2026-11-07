import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

// DELETE /api/account/views/favorites/[viewId] — Remove from favorites
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ viewId: string }> },
) {
  const { viewId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('view_favorite')
    .delete()
    .eq('user_id', user.id)
    .eq('view_id', viewId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
