/**
 * One work item (ACTIVITY-AND-REVIEW-DESIGN §4.2 — the detail panel's data).
 *
 *   GET   /api/account/activity/[id]                      → { item, run, drafts, output, held_contacts, parent, children, mine }
 *   GET   /api/account/activity/[id]?light=1              → { item: { id, workspace_id, ai_team_member_id, kind, title } }
 *         who the item is, and nothing the panel joins: a click deciding where
 *         it opens (bots-v4.md Phase 2: on its teammate's bot's page, else over
 *         the Inbox) when nothing on screen holds the row (lib/bots/item-lookup.ts).
 *   PATCH /api/account/activity/[id] { action }           → { ok, changed, item }
 *         action: 'reviewed' | 'dismiss'   (needs_review → done, reviewed_at;
 *         its handoffs waiting on review with it, their notices read); owner
 *         only (403 otherwise)
 *   PATCH /api/account/activity/[id] { action: 'opened' } → { ok, changed, opened_at }
 *         the owner opened the item's panel: opened_at is stamped when empty
 *         (migration 295), any status, never moved by a later open (the
 *         recorder clears it when the row starts waiting on you again); owner
 *         only (403 otherwise). An opened item is no longer new, so its
 *         teammate's bot stops calling for it (bot-characters.md Step 3).
 *   PATCH /api/account/activity/[id] { action: 'stop_waiting' } → { ok, changed, item }
 *         "Stop waiting" on a question whose run is gone or no longer waiting
 *         on it (lib/work/stale-questions.ts stopWaitingOnQuestion): the row
 *         takes what its run says (gone: canceled), quietly. A question its run
 *         is still parked on is refused 409 (answer it, or stop the run); a row
 *         not waiting on an answer is { changed: false }. Owner only.
 *
 * Reads run on the SESSION client: `tracked_job`'s owner-only RLS is what proves
 * the row belongs to the caller (any of their memberships, so a cross-workspace
 * notification can open its item). The GET also resolves what the panel needs
 * to act: the linked agent_run's parked question (the question section posts
 * to the run's respond route), for draft deliverables the thread each draft
 * belongs to (so "Review draft" opens it in Mail), and `output` — what the
 * run actually produced, folded from its execution rows into the one shape
 * every kind shares (src/lib/work/output.ts). The one write goes through the
 * service client, fenced on the row the read returned (id + member_id) and
 * CAS-guarded on needs_review, and settles the item's handoffs still waiting
 * on review with it (row 14) and reads the item's notices (settleWorkReview,
 * the same path the main agent's settle_work_item takes, bots-v4 Phase A2).
 * `parent` / `children` are the item's place in a
 * tree of handoffs: the row that handed it the work, and the rows it handed
 * work to (row 14; the panel shows "Delegated by" and their live status).
 * `mine` says whether the caller owns the row (`ownsRow`): the panel stamps
 * `opened` only on its owner's open.
 * Send / Accept / Merge never live here
 * (NORTH-STAR invariant 5): the deliverable's own surface carries them and
 * resolves the item.
 */
import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireWorkspaceMember, type MemberAuthContext } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { markItemNoticesRead, markOpened, settleWorkReview } from '@/lib/work/resolve'
import { stopWaitingOnQuestion } from '@/lib/work/stale-questions'
import { draftRefsFrom, loadAgentRunRow, loadDraftRows, loadWorkOutput, type AgentRunRow, type DraftRow } from '@/lib/work/output'
import { loadHeldContacts, type HeldContact } from '@/lib/work/held-contacts'
import type { WorkItem } from '@/lib/work/types'
import { WORK_ITEM_SELECT } from '@/lib/work/queries'

type RouteContext = { params: Promise<{ id: string }> }

const REVIEW_ACTIONS = { reviewed: 'reviewed', dismiss: 'dismissed' } as const
type ReviewAction = keyof typeof REVIEW_ACTIONS

/** The slice of the execution row the panel acts on. */
export interface WorkItemRun {
  id: string
  status: string
  kind: string | null
  action_id: string | null
  pr_url: string | null
  pending_input: unknown | null
}

/** Where a draft deliverable lives in Mail. */
export type { WorkItemDraftRef } from '@/lib/work/output'

async function loadOwnItem(supabase: SupabaseClient, id: string): Promise<WorkItem | null> {
  const { data, error } = await supabase.from('tracked_job').select(WORK_ITEM_SELECT).eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as WorkItem | null) ?? null
}

/** What `?light=1` answers: who the item is. */
export type WorkItemFacts = Pick<WorkItem, 'id' | 'workspace_id' | 'ai_team_member_id' | 'kind' | 'title'>
const ITEM_FACTS_SELECT = 'id, workspace_id, ai_team_member_id, kind, title'

/** `?light=1`: the item's facts, under the same owner-only read as the panel's. */
async function itemFacts(supabase: SupabaseClient, id: string): Promise<Response> {
  try {
    const { data, error } = await supabase.from('tracked_job').select(ITEM_FACTS_SELECT).eq('id', id).maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return notFound('Work item not found')
    const row = data as WorkItemFacts
    const item: WorkItemFacts = {
      id: row.id,
      workspace_id: row.workspace_id,
      ai_team_member_id: row.ai_team_member_id ?? null,
      kind: row.kind,
      title: row.title,
    }
    return NextResponse.json({ item })
  } catch (err) {
    console.error('[activity] facts load failed:', err instanceof Error ? err.message : err)
    return serverError('Could not load the work item')
  }
}

/**
 * Whether the caller owns the row: its member is one of the caller's own
 * memberships. Today's owner-only SELECT already makes every row loadOwnItem
 * returns the caller's; this is checked anyway so `opened` stays the owner's
 * (and the panel's `mine` stays true only for the owner) the day that policy
 * widens to workspace members. The active workspace's member answers without
 * a read; a row from another membership reads that member row on the session
 * client (`member`'s RLS). A failed read is "not mine": the stamp is skipped,
 * never wrongly made.
 */
async function ownsRow(auth: MemberAuthContext, item: Pick<WorkItem, 'member_id'>): Promise<boolean> {
  if (!item.member_id) return false
  if (item.member_id === auth.member.id) return true
  const { data, error } = await auth.supabase
    .from('member')
    .select('id')
    .eq('id', item.member_id)
    .eq('user_id', auth.user.id)
    .maybeSingle()
  if (error) {
    console.warn('[activity] owner check failed:', error.message)
    return false
  }
  return !!data
}

/** Where an item sits in a tree of handoffs (row 14). Owner-only RLS reads
 *  them, so a tree is always the caller's own. */
async function loadTree(supabase: SupabaseClient, item: WorkItem): Promise<{ parent: WorkItem | null; children: WorkItem[] }> {
  const [parentRes, childrenRes] = await Promise.all([
    item.parent_id
      ? supabase.from('tracked_job').select(WORK_ITEM_SELECT).eq('id', item.parent_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('tracked_job').select(WORK_ITEM_SELECT).eq('parent_id', item.id).order('created_at', { ascending: true }).limit(20),
  ])
  if (parentRes.error) console.warn('[activity] parent load failed:', parentRes.error.message)
  if (childrenRes.error) console.warn('[activity] children load failed:', childrenRes.error.message)
  return {
    parent: (parentRes.data as WorkItem | null) ?? null,
    children: (childrenRes.data ?? []) as WorkItem[],
  }
}

function runOf(row: AgentRunRow | null): WorkItemRun | null {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    kind: row.kind ?? null,
    action_id: row.action_id ?? null,
    pr_url: row.pr_url ?? null,
    pending_input: row.pending_input ?? null,
  }
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (request?.nextUrl?.searchParams.get('light') === '1') return itemFacts(auth.supabase, id)
  try {
    const item = await loadOwnItem(auth.supabase, id)
    if (!item) return notFound('Work item not found')
    // The execution rows are read once and shared: the run row feeds both the
    // question section (`run`) and the output's task/log; the draft rows feed
    // both the Mail routing (`drafts`) and the output's inline drafts.
    const [agentRun, draftRows, heldContacts, tree, mine] = await Promise.all([
      loadAgentRunRow(auth.supabase, item.agent_run_id).catch((err: unknown) => {
        console.warn('[activity] run load failed:', err instanceof Error ? err.message : err)
        return null
      }),
      loadDraftRows(auth.supabase, item).catch((err: unknown) => {
        console.warn('[activity] drafts load failed:', err instanceof Error ? err.message : err)
        return [] as DraftRow[]
      }),
      // Contacts this run created that are still held from HubSpot — the
      // review card's tier-2 gate (Sequence step 2, plan A.1). Fail-soft.
      loadHeldContacts(auth.supabase, item) as Promise<HeldContact[]>,
      loadTree(auth.supabase, item),
      ownsRow(auth, item).catch(() => false),
    ])
    const output = await loadWorkOutput(auth.supabase, item, { agentRun, draftRows })
    return NextResponse.json({
      item,
      run: runOf(agentRun),
      drafts: draftRefsFrom(draftRows),
      output,
      held_contacts: heldContacts,
      parent: tree.parent,
      children: tree.children,
      mine,
    })
  } catch (err) {
    console.error('[activity] load failed:', err instanceof Error ? err.message : err)
    return serverError('Could not load the work item')
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params

  let body: { action?: unknown }
  try {
    body = (await request.json()) as { action?: unknown }
  } catch {
    return badRequest('Invalid JSON body')
  }
  const action = body?.action
  if (action === 'opened') return stampOpened(auth, id)
  if (action === 'stop_waiting') return stopWaiting(auth, id)
  if (action !== 'reviewed' && action !== 'dismiss') {
    return badRequest("action must be 'reviewed', 'dismiss', 'opened' or 'stop_waiting'")
  }

  try {
    const item = await loadOwnItem(auth.supabase, id)
    if (!item) return notFound('Work item not found')
    // The owner only, as for `opened`: the writes below (the settle and the
    // notice reads) run on the service client, so this does not lean on the
    // read's RLS staying owner-only.
    if (!(await ownsRow(auth, item))) return forbidden('Only the owner reviews a work item')
    if (item.status !== 'needs_review') {
      return NextResponse.json({ ok: true, changed: false, item })
    }
    const outcome = REVIEW_ACTIONS[action as ReviewAction]
    // Its handoffs waiting on review are reviewed with it (row 14), and its
    // notices are read (resolve.ts settleWorkReview).
    const { changed } = await settleWorkReview(getServiceClient(), item, outcome)
    const after = (await loadOwnItem(auth.supabase, id)) ?? item
    return NextResponse.json({ ok: true, changed, item: after })
  } catch (err) {
    console.error('[activity] review failed:', err instanceof Error ? err.message : err)
    return serverError('Could not update the work item')
  }
}

/**
 * `opened`: the owner opened the item's panel. Stamps `opened_at` when it is
 * empty, in any status, and answers with the row's `opened_at` whether this
 * call stamped it or an earlier open did (idempotent). Read under RLS like the review verbs,
 * then the owner check, then the write on the service client fenced on the
 * row's member and on `opened_at IS NULL` (resolve.ts markOpened).
 * Every open also reads the owner's unread notices for the item (bots v3 1b,
 * markItemNoticesRead), stamped before or not: a notice that landed after an
 * earlier open is read by this one.
 */
async function stampOpened(auth: MemberAuthContext, id: string): Promise<Response> {
  try {
    const item = await loadOwnItem(auth.supabase, id)
    if (!item) return notFound('Work item not found')
    if (!(await ownsRow(auth, item))) return forbidden('Only the owner opens a work item')
    const nowIso = new Date().toISOString()
    await markItemNoticesRead(getServiceClient(), item, { nowIso })
    if (item.opened_at) return NextResponse.json({ ok: true, changed: false, opened_at: item.opened_at })
    const changed = await markOpened(getServiceClient(), item, { nowIso })
    // Lost the race to another open (or the write failed): report what is stored.
    const openedAt = changed ? nowIso : ((await loadOwnItem(auth.supabase, id))?.opened_at ?? null)
    return NextResponse.json({ ok: true, changed, opened_at: openedAt })
  } catch (err) {
    console.error('[activity] open stamp failed:', err instanceof Error ? err.message : err)
    return serverError('Could not update the work item')
  }
}

/**
 * `stop_waiting`: the owner stops waiting on a question nobody can answer any
 * more (its run is gone, or no longer parked on it). Read under RLS, the owner
 * check, then stopWaitingOnQuestion on the service client, fenced on the row's
 * member and on `needs_input`. A live question is refused: it is answered, or
 * its run is stopped.
 */
async function stopWaiting(auth: MemberAuthContext, id: string): Promise<Response> {
  try {
    const item = await loadOwnItem(auth.supabase, id)
    if (!item) return notFound('Work item not found')
    if (!(await ownsRow(auth, item))) return forbidden('Only the owner stops waiting on a work item')
    const result = await stopWaitingOnQuestion(getServiceClient(), {
      id: item.id,
      member_id: item.member_id,
      workspace_id: item.workspace_id,
      agent_run_id: item.agent_run_id ?? null,
      status: item.status,
    })
    if (result.outcome === 'live') {
      return apiError('Its run is still waiting on your answer: answer it, or stop the run', { status: 409, code: 'QUESTION_LIVE' })
    }
    const after = (await loadOwnItem(auth.supabase, id)) ?? item
    return NextResponse.json({ ok: true, changed: result.outcome === 'stopped', item: after })
  } catch (err) {
    console.error('[activity] stop waiting failed:', err instanceof Error ? err.message : err)
    return serverError('Could not update the work item')
  }
}
