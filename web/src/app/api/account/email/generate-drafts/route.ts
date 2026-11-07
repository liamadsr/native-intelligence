import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { generateEmailDrafts, parseDraftTone } from '@/lib/crm/email-drafts'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 120

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json().catch(() => ({}))

  const result = await generateEmailDrafts(user.id, workspaceId, {
    thread_ids: body.thread_ids,
    max_drafts: body.max_drafts,
    // A tone only when asked; otherwise the draft writes the way they do.
    tone: parseDraftTone(body.tone),
    // A person asked (the chat tool calls this as them): never the automatic
    // daily cap, which counts only metadata.origin 'automatic' rows.
    origin: 'chat',
  })

  return NextResponse.json(result)
}
