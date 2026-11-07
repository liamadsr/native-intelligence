import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { appendAgentMessage } from '@/lib/live-agent/conversation-writer'
import {
  describeAttachedPackages,
  packageSetFingerprint,
} from '@/lib/live-agent/package-greeting'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/chat-history/live/packages-ack — acknowledge a MID-CALL
 * change to the capture's attached context packages in the live conversation.
 * Attach-at-start is
 * covered by the greeting itself (../route.ts); this exists because the chip
 * is usable mid-call and the user should see the agent register the change.
 *
 * Fired best-effort by the "+ Packages" chip after its captures PATCH. No-ops
 * (200) when there is no live conversation for the capture (attach-before-
 * start, batch-only captures) or when nothing visible is attached. The
 * message id embeds a fingerprint of the attach set, so re-acking the same
 * set dedupes on the messages unique index instead of spamming the thread.
 * Names resolve under the caller's RLS — never from client labels.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { capture_id } = (await request.json().catch(() => ({}))) as { capture_id?: string }
  if (!capture_id) return NextResponse.json({ error: 'capture_id required' }, { status: 400 })

  const { data: capture } = await supabase
    .from('captures')
    .select('id, user_id, package_ids')
    .eq('id', capture_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!capture) return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  if (capture.user_id !== user.id) {
    // Owner-only, same as the live conversation itself.
    return NextResponse.json({ error: 'Only the capture owner has a live conversation' }, { status: 403 })
  }

  // No live conversation → nothing to acknowledge into (the greeting will
  // name the packages when the conversation is created).
  const { data: conv } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('capture_id', capture_id)
    .maybeSingle()
  if (!conv?.id) return NextResponse.json({ acked: false })

  const packageIds = (capture.package_ids as string[] | null) ?? []
  const line = await describeAttachedPackages(supabase, packageIds)
  if (!line) return NextResponse.json({ acked: false })

  await appendAgentMessage(supabase, {
    captureId: capture_id,
    messageId: `packages-ack-${capture_id}-${packageSetFingerprint(packageIds)}`,
    parts: [{ type: 'text', text: line }],
    metadata: { kind: 'packages-ack' },
  })
  return NextResponse.json({ acked: true })
}
