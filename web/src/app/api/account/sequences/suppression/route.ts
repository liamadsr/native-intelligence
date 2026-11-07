/**
 * /api/account/sequences/suppression — the workspace do-not-email list.
 *
 * One row per lower(email) per workspace (functional unique index, migration
 * 227). Reasons: 'opted_out' (set by the opt-out flow) and 'manual' (set
 * here). The engine's claim step checks this list before every send; enroll
 * checks it at staging time.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { escapeIlikePattern } from '@/lib/sequences/engine-logic'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('outreach_suppression')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error('[sequences] suppression list failed:', error.message)
    return serverError()
  }
  return NextResponse.json({ suppressions: data ?? [] })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) return badRequest('A valid email is required')

  const { data, error } = await supabase
    .from('outreach_suppression')
    .insert({
      workspace_id: workspaceId,
      email,
      reason: 'manual',
      created_by: user.id,
    })
    .select('*')
    .single()
  if (error) {
    // Already suppressed (unique on workspace + lower(email)) — idempotent OK.
    if (error.code === '23505') {
      return NextResponse.json({ suppressed: true, already: true })
    }
    console.error('[sequences] suppression insert failed:', error.message)
    return serverError()
  }
  return NextResponse.json({ suppressed: true, suppression: data }, { status: 201 })
}

export async function DELETE(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!email) return badRequest('email is required')

  // Case-insensitive match (rows may predate the lowercasing writers); the
  // pattern is escaped so underscores in the address match literally.
  const { data, error } = await supabase
    .from('outreach_suppression')
    .delete()
    .eq('workspace_id', workspaceId)
    .ilike('email', escapeIlikePattern(email))
    .select('id')
  if (error) {
    console.error('[sequences] suppression delete failed:', error.message)
    return serverError()
  }
  return NextResponse.json({ removed: data?.length ?? 0 })
}
