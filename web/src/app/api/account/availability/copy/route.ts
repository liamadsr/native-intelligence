import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { availabilityText, isCopyRange } from '@/lib/availability/copy-text'

/**
 * /api/account/availability/copy — the calendar toolbar's "Copy
 * availability": the caller's free time for a range as plain text
 * (src/lib/availability/copy-text.ts), worked out here by the same engine as
 * find_times. Read only on the click; nothing is kept.
 *
 *   GET ?range=today|this_week|next_7_days|next_14_days&tz=<browser zone>
 *     → { known: true, text, time_zone } or { known: false, reason }
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const params = new URL(request.url).searchParams
  const range = params.get('range')
  if (!isCopyRange(range)) return badRequest('range is today, this_week, next_7_days or next_14_days')
  try {
    const out = await availabilityText({ userId: auth.user.id, workspaceId: auth.workspaceId, range, browserTimeZone: params.get('tz'), now: Date.now() })
    return NextResponse.json(out.known ? { known: true, text: out.text, time_zone: out.timeZone } : { known: false, reason: out.reason }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read your availability')
  }
}
