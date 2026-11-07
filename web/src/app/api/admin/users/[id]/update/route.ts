import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await request.json()
  const { user_metadata, email, ban } = body

  const supabase = await getAdminServiceClient()

  // Build the Supabase admin update payload
  const updatePayload: Parameters<typeof supabase.auth.admin.updateUserById>[1] = {}

  if (user_metadata && typeof user_metadata === 'object') {
    updatePayload.user_metadata = user_metadata
  }

  if (email && typeof email === 'string') {
    updatePayload.email = email
  }

  // Handle ban/unban via ban_duration. In GoTrue, 'none' LIFTS a ban and a
  // ban needs a real duration, so ban = ~100 years. The admin panel sends
  // `ban` on every save, so only touch ban_duration when the flag actually
  // differs from the user's current state; an unrelated edit (notes, email)
  // must never re-ban or extend an existing ban.
  if (typeof ban === 'boolean') {
    const { data: current, error: currentError } = await supabase.auth.admin.getUserById(id)
    if (currentError) {
      return NextResponse.json({ error: currentError.message }, { status: 500 })
    }
    const bannedUntil = current.user?.banned_until
    const isBanned = !!bannedUntil && new Date(bannedUntil).getTime() > Date.now()
    if (ban !== isBanned) {
      updatePayload.ban_duration = ban ? '876000h' : 'none'
    }
  }

  const hasChanges = Object.keys(updatePayload).length > 0
  // A ban flag that already matches the current state is a valid no-op.
  if (!hasChanges && typeof ban !== 'boolean') {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  if (hasChanges) {
    const { error } = await supabase.auth.admin.updateUserById(id, updatePayload)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  // Re-fetch to get latest state
  const { data, error: fetchError } = await supabase.auth.admin.getUserById(id)
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  return NextResponse.json({ user: data.user })
}
