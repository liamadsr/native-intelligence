/**
 * GET /api/account/agent-work: what the bots show. Two reads; anything else
 * is a 400.
 *
 * `?light=1` is the always-on read (AgentWorkProvider in the dashboard shell,
 * for what the bots show), across EVERY workspace the caller belongs to:
 *
 *   items          the OPEN rows in light columns (listOpenWorkInWorkspaces),
 *                  then the caller's runs that finished `done` with something
 *                  made in the last day and weren't opened, with their
 *                  `deliverables`, `finished_at` and `title`
 *                  (listRecentDoneWork: what a "done" peek speaks for, so it
 *                  survives a reload). On the session client, `tracked_job`'s
 *                  owner-only SELECT makes that the caller's own rows.
 *   card_rows      the rows EVERY pending, unexpired attention card of the
 *                  caller points at (listPendingCardRows; not only the
 *                  attention route's newest 50, since cards also arrive live),
 *                  in light columns with `opened_at` (CARD_RUN_ROW_SELECT):
 *                  where a card finds its owner when its run's row is outside
 *                  `items`, and whether its run's batch has been opened.
 *   roster         the teammates in those workspaces, each with its role's
 *                  breaker state (agent-roster.ts, LIGHT_READS_BREAKERS), and
 *                  whether the caller may talk to it (`reachable`, the
 *                  private-team rule, bots-v4 Phase C: an unreachable bot's
 *                  work shows as the Assistant's, bot-owner.ts).
 *   workspace_ids  the set this answer covers. The realtime channel admits a
 *                  pushed row only when its workspace is in this set. The
 *                  server resolves the set from the caller's memberships (RLS
 *                  on `member`); it is never read from the request.
 *   current_workspace_id  the active workspace.
 *   ai_limited     the teammates the AI usage limit has stopped, each with its
 *                  workspace and when (listAiLimitedTeammates: its newest run
 *                  in the last 48 hours failed on the limit), and
 *                  `ai_limited_as_of`, when that was read: their bots sleep,
 *                  and their bubble and page say why (bots-v4 Phase 4b). A
 *                  pushed row started after it moves it on (use-agent-work.ts).
 *
 * Measured on PROD (2026-09-30, docs/plans/bot-characters.md Step 3): the
 * light answer (before Phase 4b) was ~17 KB for the heaviest user.
 *
 * `?teammate=<id>` is one teammate's work, for its bot (docs/plans/bots-v4.md,
 * "A bot's page"; use-bot-work.ts). The teammate must be visible to the caller
 * under RLS, in a workspace they're a member of, and reachable under the
 * private-team rule (resolveVisibleTeammate, callerCanReachTeammate); anything
 * else is a 404, the same as no such teammate. The answer:
 *
 *   teammate_id, workspace_id  who it is for, and where it works.
 *   items          its rows, as the caller's member there: open ones however
 *                  old, plus every one it started in the last 14 days, plus
 *                  the other rows of each handoff tree it worked in, whole
 *                  (listTeammateWork). The 14 days are by `created_at`, when
 *                  a run started: a run that started earlier and settled
 *                  inside them isn't in it.
 *   chips          per item, the entities it touched, named (row 10;
 *                  work-item-chips.ts). Fail-soft: a failed read is no chips.
 *   teammate       its roster entry, with its role's breaker.
 *   may_resume     the caller is an owner or admin of its workspace (Resume).
 *   last_finished  the row that settled last (when it finished, else when it
 *                  started), however long ago (readLastFinished).
 *   skills, agent, loops  what its page's About says (bots-v4.md Phase 1b):
 *                  the shared skills it always checks, in order; the custom
 *                  agent it's built on, if any (which also tells Customize
 *                  what kind of bot it is); the loops its bot fronts, by id
 *                  (teammate-about.ts). Fail-soft, part by part.
 *   window_days    14 (by `created_at`).
 *
 * With `&last=1`, only `teammate_id`, `workspace_id` and `last_finished`: the
 * bubble's "Last finished", read when it opens, so it's there after a reload.
 * `teammate` wins over `light`.
 *
 * Owners (lib/work/bot-owner.ts, Liam 2026-10-08): work with no bot the
 * caller can reach is its workspace's Assistant's. The light answer's `items`
 * and `card_rows` come named that way, read off the answer's own `roster`
 * (the client applies the same rule to what it's pushed later). A workspace
 * in span whose roster has no Assistant gets one first: the light read calls
 * `seed_system_teammates` for it once and reads the roster again
 * (lib/work/assistant-heal.ts; fail-soft, and nothing extra when every
 * Assistant is there).
 * `?teammate=<the Assistant>` reads its own rows AND every row no other
 * reachable bot holds (no teammate, a deleted bot's, one behind a private
 * team), but sequence sends, which keep no bot (queries.ts
 * TeammateScope.unowned), each named for it; so does its `last_finished`.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { resolveMemberships } from '@/app/api/account/notifications/scope'
import { resolveVisibleTeammate, type VisibleTeammate } from '@/lib/chat/teammate-chat'
import { getServiceClient } from '@/lib/supabase/service'
import { loadAgentRoster } from '@/lib/work/agent-roster'
import { loadTeammateAbout } from '@/lib/work/teammate-about'
import { loadWorkItemChips } from '@/lib/work/work-item-chips'
import {
  WORK_FEED_WINDOW_DAYS,
  listAiLimitedTeammates,
  listOpenWorkInWorkspaces,
  listPendingCardRows,
  listRecentDoneWork,
  listTeammateWork,
  readLastFinished,
} from '@/lib/work/queries'
import { LIGHT_READS_BREAKERS } from '@/lib/work/light-read'
import { KINDS_WITHOUT_BOT, NO_BOT_OWNERS, botOwnersFromRoster, withBotOwner, withBotOwners, type BotOwners } from '@/lib/work/bot-owner'
import { loadBotOwners, otherReachableTeammates } from '@/lib/work/bot-owner-server'
import { healMissingAssistants } from '@/lib/work/assistant-heal'
import { isAreaFaceKey } from '@/lib/work/work-area'

/** `?light=1`: the always-on read (see above). */
const LIGHT_PARAM = 'light'
/** `?teammate=<id>`: one teammate's work (see above). */
const TEAMMATE_PARAM = 'teammate'
/** `&last=1` with it: only its last finished row. */
const LAST_PARAM = 'last'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const params = new URL(request.url).searchParams
  const now = new Date()

  const teammateId = params.get(TEAMMATE_PARAM)
  if (teammateId !== null) return teammateWork(supabase, user.id, teammateId, params.get(LAST_PARAM) === '1', now)
  // The light read is the only other one: anything else is a 400 before any read.
  const light = params.get(LIGHT_PARAM) === '1'
  if (!light) return badRequest('Ask for light=1 or teammate=<id>')

  const memberships = await resolveMemberships(supabase, user.id)
  if (memberships instanceof Response) return memberships
  const workspaceIds = [...new Set(memberships.map((m) => m.workspaceId))]

  const nowIso = now.toISOString()

  // The caller's member row in each workspace: the done rows and the AI limit
  // are read as it (queries.ts listRecentDoneWork, listAiLimitedTeammates).
  const scope = memberships.filter((m) => workspaceIds.includes(m.workspaceId))

  if (light) {
    const readRoster = () =>
      loadAgentRoster({ session: supabase, service: LIGHT_READS_BREAKERS ? getServiceClient() : null, workspaceIds, userId: user.id, now })
    const [open, firstRoster, cardRows, done, aiLimited] = await Promise.all([
      listOpenWorkInWorkspaces(supabase, { workspaceIds }),
      readRoster(),
      listPendingCardRows(supabase, { workspaceIds, nowIso }),
      listRecentDoneWork(supabase, { scope, now }),
      listAiLimitedTeammates(supabase, { scope, now }),
    ])
    if (open.error || firstRoster.error) {
      console.error('[agent-work] light read failed:', open.error ?? firstRoster.error)
      return serverError(open.error ? 'Could not read the work feed' : 'Could not read the roster')
    }
    // A workspace with no Assistant would show its unowned work nowhere: seed it
    // (assistant-heal.ts; nothing is called when every Assistant is there) and,
    // when that added one, read the roster again so this answer carries it.
    let roster = firstRoster
    const healed = await healMissingAssistants({ service: getServiceClient, workspaceIds, roster: firstRoster.roster })
    if (healed.length > 0) {
      const again = await readRoster()
      if (again.error) console.error('[agent-work] roster re-read after the Assistant self-heal failed:', again.error)
      else roster = again
    }
    // The open rows, then the done ones (two statuses, so never the same row; a guard all the same).
    const held = new Set(open.items.map((r) => r.id))
    // Work no reachable bot holds is its workspace's Assistant's (the owner rule, off this
    // roster, exactly as the client reads it: at the roster's cap, a missing teammate is unknown).
    const owners = botOwnersFromRoster(roster.roster)
    return NextResponse.json({
      light: true,
      items: withBotOwners([...open.items, ...done.filter((r) => !held.has(r.id))], owners),
      card_rows: withBotOwners(cardRows, owners),
      roster: roster.roster,
      workspace_ids: workspaceIds,
      current_workspace_id: workspaceId,
      ai_limited: aiLimited,
      ai_limited_as_of: nowIso,
    })
  }

  return badRequest('Ask for light=1 or teammate=<id>')
}

/** `?teammate=<id>` (and `&last=1`): one teammate's work, checked first (see above). */
async function teammateWork(
  supabase: SupabaseClient,
  userId: string,
  teammateId: string,
  lastOnly: boolean,
  now: Date,
): Promise<Response> {
  if (!UUID.test(teammateId)) return badRequest('teammate must be a teammate id')
  let mate: VisibleTeammate | null
  try {
    mate = await resolveVisibleTeammate(supabase, userId, teammateId)
  } catch (err) {
    console.error('[agent-work] teammate check failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read the teammate')
  }
  // Hidden by RLS, in a workspace the caller isn't in, or on a private team
  // they aren't on: one answer for all three, the same as no such teammate.
  if (!mate) return notFound('Teammate not found')
  // One face (always-on-agent §2c): an area face's page is the agent's, so
  // its work is read as its workspace's Assistant's (which holds it).
  if (mate.isSystem && isAreaFaceKey(mate.systemKey)) {
    const { data: assistant, error } = await supabase
      .from('ai_team_member')
      .select('id')
      .eq('workspace_id', mate.workspaceId)
      .eq('system_key', 'assistant')
      .maybeSingle()
    if (error) console.error('[agent-work] Assistant read for an area face failed:', error.message)
    const agentId = (assistant as { id: string } | null)?.id
    if (agentId && agentId !== mate.id) return teammateWork(supabase, userId, agentId, lastOnly, now)
  }
  // The workspace's Assistant also holds the work no reachable bot does (the owner rule).
  const owners: BotOwners =
    mate.systemKey === 'assistant' ? await loadBotOwners(supabase, { userId, workspaceIds: [mate.workspaceId], teammateIds: 'all' }) : NO_BOT_OWNERS
  const isAssistant = owners.assistants.get(mate.workspaceId)?.id === mate.id
  const scope = {
    teammateId: mate.id,
    workspaceId: mate.workspaceId,
    memberIds: [mate.memberId],
    ...(isAssistant
      ? { unowned: { otherTeammateIds: otherReachableTeammates(owners, mate.workspaceId), kindsWithoutBot: [...KINDS_WITHOUT_BOT] } }
      : {}),
  }
  const head = { teammate_id: mate.id, workspace_id: mate.workspaceId }
  const owned = <T extends Parameters<typeof withBotOwner>[0]>(row: T | null): T | null => (row ? withBotOwner(row, owners) : null)

  if (lastOnly) {
    const last = await readLastFinished(supabase, scope)
    if (last.error) {
      console.error('[agent-work] last finished read failed:', last.error)
      return serverError('Could not read the work feed')
    }
    return NextResponse.json({ ...head, last_finished: owned(last.row) })
  }

  const sinceIso = new Date(now.getTime() - WORK_FEED_WINDOW_DAYS * 86_400_000).toISOString()
  const [work, roster, manages, about] = await Promise.all([
    listTeammateWork(supabase, { ...scope, sinceIso }),
    loadAgentRoster({ session: supabase, service: getServiceClient(), workspaceIds: [mate.workspaceId], teammateIds: [mate.id], userId, now }),
    supabase.from('member').select('id').eq('id', mate.memberId).in('role', ['owner', 'admin']).maybeSingle(),
    loadTeammateAbout(supabase, { teammateId: mate.id, workspaceId: mate.workspaceId }),
  ])
  if (work.error || roster.error) {
    console.error('[agent-work] teammate read failed:', work.error ?? roster.error)
    return serverError(work.error ? 'Could not read the work feed' : 'Could not read the roster')
  }
  // A failed read only hides Resume; it never fails the answer.
  if (manages.error) console.error('[agent-work] admin membership read failed:', manages.error.message)
  const chips = await loadWorkItemChips(supabase, work.items)

  return NextResponse.json({
    ...head,
    items: withBotOwners(work.items, owners),
    chips,
    teammate: roster.roster[0] ?? null,
    may_resume: !manages.error && !!manages.data,
    last_finished: owned(work.lastFinished),
    skills: about.skills,
    agent: about.agent,
    loops: about.loops,
    window_days: WORK_FEED_WINDOW_DAYS,
  })
}
