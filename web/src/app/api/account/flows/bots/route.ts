/**
 * GET /api/account/flows/bots — what the loop editor's "Its bot" picker offers
 * (bots-v3 Phase 3, flow-bot.ts):
 *
 *   teammates        the bots the caller's teammates wear (that may front
 *                    loops and that the caller can reach), each with the loops
 *                    it already fronts;
 *   free_characters  the characters nobody in the workspace wears yet;
 *   suggested        the default for a NEW loop running `skill_ids` (comma
 *                    separated): the skill's holder, else Triage for a verdict
 *                    skill, else a free character (a work bot made on save).
 *
 * A teammate wearing a built bot is listed like any other. A bot built for a
 * new loop ("Build one…", Phase 6) is picked on the client and sent as its
 * `bot_character` on save, like a free character; it is never offered here.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { listFlowBotOptions, suggestFlowBot } from '@/lib/flows/flow-bot'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const service = getServiceClient()

  const skillIds = (request.nextUrl.searchParams.get('skill_ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)

  try {
    const [options, suggested] = await Promise.all([
      listFlowBotOptions(supabase, service, { workspaceId, userId: user.id }),
      suggestFlowBot(service, {
        workspaceId,
        userId: user.id,
        actions: skillIds.map((id) => ({ type: 'run_skill', enabled: true, config: { skill_id: id } })),
      }),
    ])
    return NextResponse.json({ ...options, suggested })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the agents')
  }
}
