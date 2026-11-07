/**
 * GET /api/account/email/agent-drafts: the email drafts the person's bots
 * wrote that still wait in Mail, across every workspace they're in, newest
 * first (src/lib/email/agent-drafts-server.ts): the For you column's draft cards.
 * The session client, so RLS keeps it to the mailbox owner's own rows.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { readAgentDrafts } from '@/lib/email/agent-drafts-server'

export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  try {
    const drafts = await readAgentDrafts(auth.supabase, auth.user.id)
    return NextResponse.json({ drafts })
  } catch (err) {
    console.error('[agent-drafts]', err instanceof Error ? err.message : err)
    return serverError('Failed to load drafts')
  }
}
