import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { buildBrief } from '@/lib/listen-briefs/build'
import type { BriefContext } from '@/lib/listen-briefs/context'
import { LISTEN_BRIEF_KINDS } from '@/lib/listen-briefs/kinds'
import { safeTimeZone } from '@/lib/listen-briefs/when'

/**
 * POST /api/account/listen/brief — a Listen brief: what listen mode says about
 * the item the user just opened (how it works: lib/listen-briefs/build.ts).
 * Plain code over the workspace's rows; no model is called.
 *
 * Body: { kind, id, timeZone?, input? }. `timeZone` (IANA) is the user's, for
 * "yesterday at 3 PM"; `input` is only for an item that lives outside the
 * database (a calendar event: what the calendar shows).
 *
 * Answers 200 { sentences: string[] }, or 404 when the item isn't found or
 * isn't the user's to see (indistinguishable).
 */

const bodySchema = z.object({
  kind: z.enum(LISTEN_BRIEF_KINDS),
  id: z.string().min(1).max(200),
  timeZone: z.string().max(64).optional(),
  input: z.unknown().optional(),
})

export async function POST(req: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return badRequest('kind and id are required')
  const { kind, id, timeZone, input } = parsed.data

  const ctx: BriefContext = {
    supabase,
    service: getServiceClient(),
    workspaceId,
    userId: user.id,
    memberId: member.id,
    userEmail: user.email ?? null,
    clock: { now: new Date(), timeZone: safeTimeZone(timeZone) },
  }
  const sentences = await buildBrief(kind, id, ctx, input)
  if (!sentences) return notFound()
  return NextResponse.json({ sentences }, { headers: { 'cache-control': 'no-store' } })
}
