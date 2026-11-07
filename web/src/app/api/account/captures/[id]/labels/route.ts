import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // Verify the capture belongs to this workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) return notFound('Capture not found')

  const { data, error } = await supabase
    .from('capture_label')
    .select('label:label(id, name, color)')
    .eq('capture_id', id)

  if (error) return serverError(error.message)

  const labels = (data || []).map((row) => row.label).filter(Boolean)
  return NextResponse.json({ labels })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params
  const body = await request.json()

  if (!body.label_id) return badRequest('label_id is required')

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
    .insert({ capture_id: id, label_id: body.label_id })

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Label already attached' }, { status: 409 })
    }
    return serverError(error.message)
  }

  return NextResponse.json({ success: true })
}
