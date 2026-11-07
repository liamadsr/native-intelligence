import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { fetchThreadHeaders, HEADERS_MAX_ROWS, type HeaderRow } from '@/lib/email/thread-headers'

export const maxDuration = 15

/**
 * POST /api/account/email/threads/headers  { ids: string[] }
 *   → { headers: { [indexRowId]: { subject, snippet, from_name } } }
 *
 * The inbox's second pass (no stored mail, 2026-10-15): the list renders from
 * the index (ids, flags, addresses), then asks here for the subjects and
 * previews of the rows on screen. One batched provider call per mailbox
 * (src/lib/email/thread-headers.ts); a held row answers from its hold. Only
 * the caller's own rows in the current workspace are read. The browser keeps
 * the answers in memory only.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let ids: string[]
  try {
    const body = (await request.json()) as { ids?: unknown }
    ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && id.length <= 64) : []
  } catch {
    return badRequest('Expected { ids: string[] }')
  }
  ids = [...new Set(ids)].slice(0, HEADERS_MAX_ROWS)
  if (!ids.length) return NextResponse.json({ headers: {} })

  const { data, error } = await supabase
    .from('email_thread_index')
    .select('id, account_id, provider, provider_thread_id, provider_message_id, folder')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .in('id', ids)
  if (error) return serverError(error.message)

  // In the order the client asked (the visible rows first): the Graph pool takes them in that order.
  const byId = new Map(((data ?? []) as HeaderRow[]).map((r) => [r.id, r]))
  const headers = await fetchThreadHeaders(getServiceClient(), {
    userId: user.id,
    workspaceId,
    rows: ids.map((id) => byId.get(id)).filter((r): r is HeaderRow => !!r),
  })
  return NextResponse.json({ headers }, { headers: { 'Cache-Control': 'private, no-store' } })
}
