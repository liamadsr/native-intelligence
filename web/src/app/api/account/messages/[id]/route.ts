import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'

/**
 * PATCH /api/account/messages/[id] — advance an in-app message's lifecycle.
 *
 * The in-app message channel (toast → popup) drives these transitions:
 *   - `delivered`  : a toast was shown for it (so the admin read-side knows it surfaced)
 *   - `read`       : the user opened the detail popup (announcements/tips are "done" here;
 *                    once read they are never re-toasted)
 *   - `dismissed`  : the user explicitly dismissed it
 *
 * Feedback prompts use the separate `[id]/respond` route to record an answer
 * (which sets `responded`); this route handles the read/dismiss/delivered states.
 *
 * RLS (migration 003) scopes in_app_messages to the owner, so a normal authed
 * client can only ever transition its own rows.
 */

const ALLOWED = new Set(['delivered', 'read', 'dismissed'])

// Each status flips its corresponding timestamp column.
const TIMESTAMP_COLUMN: Record<string, string> = {
  delivered: 'delivered_at',
  read: 'read_at',
  dismissed: 'dismissed_at',
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const status = String(body.status ?? '')

  if (!ALLOWED.has(status)) {
    return badRequest(`status must be one of: ${[...ALLOWED].join(', ')}`)
  }

  // Confirm ownership for a clean 404 (RLS already enforces it).
  const { data: message } = await supabase
    .from('in_app_messages')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!message) return notFound('Message not found')

  const updates: Record<string, unknown> = {
    status,
    [TIMESTAMP_COLUMN[status]]: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('in_app_messages')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) return serverError(error.message)

  return NextResponse.json({ message: data })
}
