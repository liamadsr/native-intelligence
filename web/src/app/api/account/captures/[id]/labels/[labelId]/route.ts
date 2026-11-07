import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; labelId: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id, labelId } = await params

  // Verify the capture belongs to this workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) return notFound('Capture not found')

  const { error } = await supabase
    .from('capture_label')
    .delete()
    .eq('capture_id', id)
    .eq('label_id', labelId)

  if (error) return serverError(error.message)

  return NextResponse.json({ success: true })
}
