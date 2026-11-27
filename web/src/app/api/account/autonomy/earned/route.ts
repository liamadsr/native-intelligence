/**
 * /api/account/autonomy/earned — Settings › Autonomy's "What the agent has
 * earned" and "What I did on my own today" (docs/plans/earned-autonomy.md §5,
 * §6).
 *
 * GET: the caller's own kinds of work in this workspace, each with its level,
 * its record and what it still needs (or why it always asks); and, while
 * EARNED_AUTONOMY=graduate, the actions the agent took (or is about to take)
 * on its own in the last day. Off (EARNED_AUTONOMY empty) it answers
 * `{ enabled: false }` and reads nothing. Reads with the caller's own client
 * (RLS: owner select).
 *
 * POST `{ kind_key, decision }`: the person's own decision on one kind
 * (decide.ts): hand_over, not_now, never, allow_offers, revoke. Only from the
 * person's own session; the server re-reads the record and decides
 * eligibility itself, never on the client's word (Liam, 11-27, decision 1:
 * this yes is their final yes for the kind; "Revoke stays available at any
 * time"). Written with the service role, fenced on the caller's id and
 * workspace.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { earnedAutonomyGraduating, earnedAutonomyMode, earnedAutonomyQuiet } from '@/lib/autonomy/config'
import { listKindSummaries } from '@/lib/autonomy/records'
import { decideKind, isKindDecision } from '@/lib/autonomy/decide'
import { parseKindKey } from '@/lib/autonomy/kind'
import { hardLimitOfKind } from '@/lib/autonomy/hard-limits'
import { getServiceClient } from '@/lib/supabase/service'

const DAY = 86_400_000

export async function GET(): Promise<Response> {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const mode = earnedAutonomyMode()
  if (mode === 'off') return NextResponse.json({ enabled: false, mode, kinds: [], actions: [] })
  try {
    const kinds = await listKindSummaries(supabase, { userId: user.id, workspaceId, quiet: earnedAutonomyQuiet() })
    let actions: unknown[] = []
    if (mode === 'graduate') {
      const { data, error } = await supabase
        .from('autonomy_action')
        .select('id, kind_key, tool, level, status, title, recipients, run_at, ran_at, card_id, reason, created_at')
        .eq('user_id', user.id)
        .eq('workspace_id', workspaceId)
        .gte('created_at', new Date(Date.now() - DAY).toISOString())
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw new Error(error.message)
      actions = data ?? []
    }
    return NextResponse.json({ enabled: true, mode, kinds, actions })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the record')
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  if (earnedAutonomyMode() === 'off') return badRequest('Earned autonomy is off')
  const body = (await request.json().catch(() => ({}))) as { kind_key?: unknown; decision?: unknown }
  const key = typeof body.kind_key === 'string' ? body.kind_key : ''
  const parsed = parseKindKey(key)
  if (!parsed) return badRequest('kind_key is not a kind')
  if (!isKindDecision(body.decision)) return badRequest('decision must be hand_over, not_now, never, allow_offers or revoke')
  try {
    const kinds = await listKindSummaries(supabase, { userId: user.id, workspaceId, quiet: earnedAutonomyQuiet() })
    const current = kinds.find((k) => k.key === key) ?? { level: 'ask' as const, eligible: null, blocked: null }
    const result = decideKind(body.decision, current, { graduating: earnedAutonomyGraduating(), hardLimited: hardLimitOfKind(parsed) !== null, now: new Date() })
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: 409 })
    const { error } = await getServiceClient()
      .from('autonomy_kind')
      .upsert({ workspace_id: workspaceId, user_id: user.id, kind_key: key, ...result.patch, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id,user_id,kind_key' })
    if (error) return serverError(error.message)
    return NextResponse.json({ ok: true, kind_key: key, decision: body.decision })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not save')
  }
}
