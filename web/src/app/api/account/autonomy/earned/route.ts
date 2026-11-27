/**
 * GET /api/account/autonomy/earned — Settings › Autonomy's "What the agent has
 * earned" (docs/plans/earned-autonomy.md §6), read-only in phase 1: the
 * caller's own kinds of work in this workspace, each with its level, its record
 * and what it still needs, or why it always asks.
 *
 * Behind EARNED_AUTONOMY (empty is off): off, it answers `{ enabled: false,
 * kinds: [] }` and reads nothing. Reads with the caller's own client (RLS:
 * owner select), so a person only ever sees their own record.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { earnedAutonomyMode } from '@/lib/autonomy/config'
import { listKindSummaries } from '@/lib/autonomy/records'

export async function GET(): Promise<Response> {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const mode = earnedAutonomyMode()
  if (mode === 'off') return NextResponse.json({ enabled: false, mode, kinds: [] })
  try {
    const kinds = await listKindSummaries(supabase, { userId: user.id, workspaceId })
    return NextResponse.json({ enabled: true, mode, kinds })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the record')
  }
}
