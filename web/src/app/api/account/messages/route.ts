import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'

/**
 * List the current user's non-dismissed, non-expired in-app messages
 * (announcements, tips, feedback prompts) with any responses. Powers the in-app
 * message channel (toast → popup) and the inbox answer flow.
 *
 * This is a PURE READ — it does NOT mutate status. Lifecycle transitions
 * (delivered when toasted, read when opened, dismissed) are driven explicitly
 * by the client via PATCH /api/account/messages/[id], so `delivered` keeps its
 * meaning ("a toast was actually shown").
 *
 * RLS (migration 003) already scopes in_app_messages to the owning user, so a
 * normal authed client only ever sees its own rows.
 */
export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from('in_app_messages')
    .select('*, message_responses(*)')
    .eq('user_id', user.id)
    .neq('status', 'dismissed')
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  return NextResponse.json({ messages: data ?? [] })
}
