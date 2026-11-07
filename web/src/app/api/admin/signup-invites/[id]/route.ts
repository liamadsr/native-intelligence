import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

/** Revoke a signup invite. A used invite is history, not access — refuse. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid invite id' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()
  const { data: existing, error: lookupError } = await supabase
    .from('signup_invite')
    .select('id, used_at')
    .eq('id', id)
    .maybeSingle()
  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
  if (existing.used_at) {
    return NextResponse.json(
      { error: 'This invite was already used; the account exists. Manage the user instead.' },
      { status: 409 },
    )
  }

  const { error } = await supabase.from('signup_invite').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
