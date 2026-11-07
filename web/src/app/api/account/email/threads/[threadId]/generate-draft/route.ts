import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { generateEmailDrafts, parseDraftTone } from '@/lib/crm/email-drafts'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 60

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { threadId } = await params
  const body = await request.json().catch(() => ({}))

  try {
    const result = await generateEmailDrafts(user.id, workspaceId, {
      thread_ids: [threadId],
      replyIntent: 'explicit',
      max_drafts: 1,
      // A tone only when asked; otherwise the draft writes the way they do.
      tone: parseDraftTone(body.tone),
    })

    if (result.drafts.length > 0) {
      return NextResponse.json(result.drafts[0])
    }

    return NextResponse.json({ error: 'No draft generated' }, { status: 404 })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to generate draft'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
