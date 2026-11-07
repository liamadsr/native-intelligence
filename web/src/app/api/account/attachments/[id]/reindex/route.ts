import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { INDEXABLE_ATTACHMENT_EXTENSIONS } from '@/lib/attachments/extract-text'

/**
 * POST /api/account/attachments/[id]/reindex
 * Re-triggers multimodal embedding for a specific attachment.
 * Useful for retrying failed embeddings or after format support is added.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params

  const { data: attachment, error } = await supabase
    .from('attachments')
    .select('id, file_extension, project_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error || !attachment) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
  }

  const ext = attachment.file_extension?.toLowerCase() || ''
  if (!INDEXABLE_ATTACHMENT_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: 'File type not eligible for embedding' }, { status: 400 })
  }

  await supabase
    .from('attachments')
    .update({ embedding_status: 'pending', embedding_error: null })
    .eq('id', id)

  await inngest.send({
    name: 'attachment/index',
    data: {
      attachmentId: id,
      userId: user.id,
      workspaceId,
      projectId: attachment.project_id || null,
    },
  })

  return NextResponse.json({ success: true, message: 'Re-indexing triggered' })
}
