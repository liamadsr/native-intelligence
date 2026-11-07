import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { syncContactsFromProvider } from '@/lib/crm/contacts'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const fullSync = body.full_sync === true

  const result = await syncContactsFromProvider(user.id, workspaceId, fullSync)

  return NextResponse.json(result)
}
