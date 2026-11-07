import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { fetchFullEmailThreadForClient } from '@/lib/crm/email-client'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 30

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { threadId } = await params

  try {
    // `account`: the mailbox a search result is in, for one the index doesn't have.
    const accountId = new URL(request.url).searchParams.get('account')
    const thread = await fetchFullEmailThreadForClient(user.id, workspaceId, threadId, { accountId })
    return NextResponse.json(thread)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to fetch thread'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
