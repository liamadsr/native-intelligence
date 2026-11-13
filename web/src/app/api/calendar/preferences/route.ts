import { NextResponse } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { authenticateUser } from '@/lib/ai/auth'
import { badRequest, serverError } from '@/lib/api-errors'

/** A failed preference upsert: a bad/unknown account id is the caller's fault. */
function upsertFailed(error: { code?: string; message: string }) {
  // 23503 = FK violation (no such account), 22P02 = malformed uuid.
  if (error.code === '23503' || error.code === '22P02') {
    return badRequest('Unknown account or calendar')
  }
  console.error('Calendar preference upsert failed:', error)
  return serverError('Failed to update preference')
}

export async function PUT(req: Request) {
  try {
    const { user } = await authenticateUser(req)
    const body = await req.json()

    const supabase = createStatelessClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { type, account_id, provider_calendar_id, is_visible, color } = body

    if (type === 'account') {
      // Toggle account-level visibility
      if (!account_id) {
        return NextResponse.json({ error: 'account_id required' }, { status: 400 })
      }

      const updateData: Record<string, any> = {}
      if (typeof is_visible === 'boolean') updateData.is_visible = is_visible
      if (color !== undefined) updateData.color_override = color

      const { error } = await supabase
        .from('calendar_account_preference')
        .upsert(
          {
            user_id: user.id,
            account_id,
            ...updateData,
          },
          { onConflict: 'user_id,account_id' },
        )
      if (error) return upsertFailed(error)

      return NextResponse.json({ success: true })
    }

    if (type === 'calendar') {
      // Toggle sub-calendar visibility
      if (!account_id || !provider_calendar_id) {
        return NextResponse.json(
          { error: 'account_id and provider_calendar_id required' },
          { status: 400 },
        )
      }

      const updateData: Record<string, any> = {}
      if (typeof is_visible === 'boolean') updateData.is_visible = is_visible
      if (color !== undefined) updateData.calendar_color = color

      const { error } = await supabase
        .from('calendar_sub_preference')
        .upsert(
          {
            user_id: user.id,
            account_id,
            provider_calendar_id,
            ...updateData,
          },
          { onConflict: 'user_id,account_id,provider_calendar_id' },
        )
      if (error) return upsertFailed(error)

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'type must be "account" or "calendar"' }, { status: 400 })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Calendar preference update error:', error)
    return NextResponse.json(
      { error: 'Failed to update preference' },
      { status: 500 },
    )
  }
}
