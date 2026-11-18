/**
 * Put a demo workspace back: clear what visitors added, seed the made-up
 * Fernhill Studio content again, keep everyone who is in it.
 *
 * Runs every night from the server's cron (/api/cron/demo-workspace-reset)
 * and on demand from the admin route (/api/admin/demo-workspace/reset), on any
 * database, production's included.
 *
 * THE GUARD: only a workspace with a row in `demo_workspace` (migration 669)
 * is ever touched. The row is read here, from the table, on every run, never
 * from a cache or from what the caller says: every other workspace is refused
 * before a single delete. Each delete below is also fenced on that one
 * workspace id.
 *
 * KEPT: the workspace, its members and their accounts, teams and board
 * columns, pending invites and the joining settings, the flag and its spend
 * ledger, everyone's devices, phones and notification choices, the default
 * pipeline and its columns, the members' own CRM contacts.
 *
 * CLEARED: the tables in WIPE: the content a visitor makes by using the app
 * (chats, tasks, contacts, companies, deals, documents, captures, team chat,
 * calls, forms, tables, flows, lists and so on), seeded or not. Then the
 * seeded content is written again, so an edited seeded row is as new.
 *
 * NOT CLEARED, by choice: saved views and agents (a workspace's own defaults
 * live in the same tables), and anything not named in WIPE. Files in storage
 * are not removed. A table that refuses (a foreign key from a table this list
 * does not know) is reported, never forced: the run goes on and says so.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createDeal, ensureDefaultPipeline, findDeals } from '@/lib/crm/deals'
import { ensureMemberContact } from '@/lib/crm/contacts'
import { clearDemoWorkspaceCache } from './demo-mode'
import { loadSeedContext, resetSeeded, seedDemoContent, WORKSPACE_NAME, type Ctx } from './seed'

export class DemoResetRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoResetRefused'
  }
}

/**
 * One table to clear, fenced on the workspace. `keep` narrows it:
 *   member_contacts   keep the contacts that ARE members (contact.member_id)
 *   default_pipeline  keep the workspace's default pipeline table
 */
export interface WipeStep {
  table: string
  keep?: 'member_contacts' | 'default_pipeline'
}

/**
 * In order: what points at a row goes before the row. Every table here has a
 * `workspace_id`. Adding a place visitors can leave content means adding its
 * table here.
 */
export const WIPE: readonly WipeStep[] = [
  // Links, approvals and feeds that only hold ids.
  { table: 'entity_link' },
  { table: 'entity_activity' },
  { table: 'comment' },
  { table: 'tool_approval' },
  { table: 'agent_run' },
  { table: 'agent_event' },
  { table: 'notification' },
  { table: 'attention_item' },
  { table: 'proposed_change' },
  { table: 'kept_change' },
  { table: 'decision' },
  { table: 'claim' },
  // Conversations: the assistant's and the team's.
  { table: 'team_chat_reaction' },
  { table: 'team_chat_message' },
  { table: 'team_chat_channel' },
  { table: 'team_call' },
  { table: 'home_turn' },
  { table: 'bot_relay' },
  { table: 'chat_conversations' },
  { table: 'agent_memory' },
  { table: 'area_memory' },
  { table: 'profile_fact' },
  // Work.
  { table: 'actions' },
  { table: 'captures' },
  { table: 'meeting' },
  { table: 'contact_interaction' },
  { table: 'data_row' },
  { table: 'data_form' },
  { table: 'data_table', keep: 'default_pipeline' },
  { table: 'document' },
  { table: 'email_draft' },
  { table: 'email_scheduled_send' },
  { table: 'sms_message' },
  { table: 'flow_page_watch' },
  { table: 'flow_run' },
  { table: 'flow' },
  { table: 'sequence' },
  { table: 'campaign' },
  { table: 'prospecting_run' },
  { table: 'prospect_list' },
  { table: 'seo_rank_tracker' },
  { table: 'seo_ai_tracker' },
  { table: 'seo_audit' },
  { table: 'seo_local_grid' },
  { table: 'seo_saved_keyword' },
  { table: 'studio_video' },
  { table: 'studio_asset' },
  { table: 'studio_project' },
  { table: 'booking_link' },
  { table: 'time_offer' },
  { table: 'customer_quote' },
  { table: 'payment_request' },
  { table: 'review_request' },
  { table: 'reminder' },
  { table: 'website_site' },
  { table: 'eval_suite' },
  { table: 'knowledge_package' },
  { table: 'knowledge_brief' },
  { table: 'vocabulary_term' },
  { table: 'share' },
  { table: 'milestone' },
  { table: 'projects' },
  { table: 'cycle' },
  { table: 'initiative' },
  { table: 'label' },
  { table: 'contact', keep: 'member_contacts' },
  { table: 'company' },
  { table: 'local_calendar_event' },
]

/** Tables the reset must never clear: who is in the workspace, and how they got there. */
export const NEVER_WIPED: readonly string[] = [
  'workspace',
  'member',
  'team',
  'team_member',
  'workflow_state',
  'invite',
  'demo_workspace',
  'workspace_join_settings',
  'workspace_join_link',
  'workspace_join_domain',
  'subscriptions',
  'device_token',
  'push_token',
  'notification_preference',
]

export interface DemoResetReport {
  workspaceId: string
  /** Rows deleted per table (only tables that had any). */
  cleared: Record<string, number>
  /** Tables that refused, with the database's words. */
  failed: Record<string, string>
  seeded: boolean
  /** What stopped the seed, when it did not finish. */
  seedError: string | null
  members: number
}

/** The flag, read from the table itself. Throws DemoResetRefused for any other workspace. */
export async function assertDemoWorkspace(service: SupabaseClient, workspaceId: string): Promise<void> {
  if (!workspaceId) throw new DemoResetRefused('refusing: no workspace named')
  const { data, error } = await service
    .from('demo_workspace')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new DemoResetRefused(`refusing: could not read the demo flag (${error.message})`)
  if (!data || (data as { workspace_id?: unknown }).workspace_id !== workspaceId) {
    throw new DemoResetRefused('refusing: this workspace is not flagged as a demo workspace')
  }
}

/** Every flagged workspace's id. */
export async function listDemoWorkspaces(service: SupabaseClient): Promise<string[]> {
  const { data, error } = await service.from('demo_workspace').select('workspace_id').order('created_at', { ascending: true })
  if (error) throw new Error(`demo_workspace: ${error.message}`)
  return ((data ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id)
}

async function wipeOne(service: SupabaseClient, workspaceId: string, step: WipeStep): Promise<{ count: number } | { error: string }> {
  if (NEVER_WIPED.includes(step.table)) return { error: 'refused: this table is never cleared' }
  let q = service.from(step.table).delete({ count: 'exact' }).eq('workspace_id', workspaceId)
  if (step.keep === 'member_contacts') q = q.is('member_id', null)
  if (step.keep === 'default_pipeline') q = q.eq('is_default', false)
  const { error, count } = await q
  if (error) return { error: error.message }
  return { count: count ?? 0 }
}

/**
 * Clear WIPE in the workspace. A table that refuses the first time (a row
 * something later in the list still points at) is tried once more at the end.
 */
export async function wipeVisitorContent(
  service: SupabaseClient,
  workspaceId: string,
): Promise<Pick<DemoResetReport, 'cleared' | 'failed'>> {
  await assertDemoWorkspace(service, workspaceId)
  const cleared: Record<string, number> = {}
  let failed: Record<string, string> = {}
  let todo: readonly WipeStep[] = WIPE
  for (let pass = 0; pass < 2 && todo.length > 0; pass++) {
    const again: WipeStep[] = []
    failed = {}
    for (const step of todo) {
      const res = await wipeOne(service, workspaceId, step)
      if ('error' in res) {
        failed[step.table] = res.error
        again.push(step)
      } else if (res.count > 0) {
        cleared[step.table] = (cleared[step.table] ?? 0) + res.count
      }
    }
    todo = again
  }
  return { cleared, failed }
}

// ── Made-up content the app's own stores write ─────────────────────────────

const DEALS = [
  { name: 'Larkspur Coffee: site relaunch', stage: 'Won', value: 28000, company: 'Larkspur Coffee', closeInDays: -20, notes: 'Signed. Kickoff done; design direction is the first milestone.' },
  { name: 'Larkspur Coffee: wholesale portal', stage: 'Proposal', value: 12500, company: 'Larkspur Coffee', closeInDays: 21, notes: 'Rosa wants ordering for wholesale accounts after the relaunch ships.' },
  { name: 'Brand refresh retainer', stage: 'Qualified', value: 6000, company: null, closeInDays: 35, notes: 'Three months of brand work, month to month after that.' },
  { name: 'Packaging concepts', stage: 'Lead', value: 4500, company: null, closeInDays: 50, notes: 'Came in through the website form. Call booked for next week.' },
] as const

const TEAM_CHAT = [
  { minutesAgo: 60 * 26, body: 'Morning. Larkspur signed off on the homepage direction, so wireframes are the focus this week.' },
  { minutesAgo: 60 * 25, body: 'Photos from the roastery shoot are in the project. The wide shots of the bar are the strongest.' },
  { minutesAgo: 60 * 5, body: 'Staging store is up. Bean subscriptions work end to end with a test card.' },
  { minutesAgo: 60 * 4, body: 'Design review is Thursday. If you are new here: have a look around, add a task, ask the assistant anything about the project.' },
] as const

async function seedDeals(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId } = ctx
  const pipelineId = await ensureDefaultPipeline(admin, workspaceId, userId)
  if (!pipelineId) return
  const { deals: existing } = await findDeals(admin, workspaceId, { limit: 100 })
  const have = new Set(existing.map((d) => d.name))
  const { data: companies } = await admin.from('company').select('id, name').eq('workspace_id', workspaceId)
  const companyId = new Map(((companies ?? []) as Array<{ id: string; name: string }>).map((c) => [c.name, c.id]))
  for (const d of DEALS) {
    if (have.has(d.name)) continue
    const res = await createDeal(
      admin,
      workspaceId,
      {
        name: d.name,
        stage: d.stage,
        value: d.value,
        company_id: d.company ? companyId.get(d.company) ?? null : null,
        expected_close_date: new Date(Date.now() + d.closeInDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        notes: d.notes,
      },
      { userId, source: 'person', reason: 'Demo workspace content' },
    )
    if (!res.ok) throw new Error(`deal "${d.name}": ${res.error}`)
  }
}

async function seedTeamChat(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, memberId } = ctx
  const { count, error: countError } = await admin
    .from('team_chat_message')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
  if (countError) throw new Error(`team_chat_message: ${countError.message}`)
  if ((count ?? 0) > 0) return

  let channelId: string | null = null
  const { data: found } = await admin
    .from('team_chat_channel')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'channel')
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  channelId = (found as { id: string } | null)?.id ?? null
  if (!channelId) {
    const { data: made, error } = await admin
      .from('team_chat_channel')
      .insert({ workspace_id: workspaceId, kind: 'channel', name: 'general', topic: `Everything ${WORKSPACE_NAME}`, created_by: memberId })
      .select('id')
      .single()
    if (error || !made) throw new Error(`team_chat_channel: ${error?.message ?? 'no row'}`)
    channelId = (made as { id: string }).id
  }
  const now = Date.now()
  const rows = TEAM_CHAT.map((m) => ({
    channel_id: channelId,
    workspace_id: workspaceId,
    author_kind: 'member',
    author_member_id: memberId,
    body: m.body,
    created_at: new Date(now - m.minutesAgo * 60 * 1000).toISOString(),
  }))
  const { error } = await admin.from('team_chat_message').insert(rows)
  if (error) throw new Error(`team_chat_message: ${error.message}`)
  await admin.from('team_chat_channel').update({ last_message_at: rows[rows.length - 1].created_at }).eq('id', channelId)
}

/**
 * The whole reset of ONE flagged workspace. Never throws for a table that
 * refused or a seed step that failed: the report says what happened, so one
 * bad table does not leave the workspace empty for a day without anyone
 * knowing why. Throws DemoResetRefused for a workspace that is not flagged.
 */
export async function resetDemoWorkspace(service: SupabaseClient, workspaceId: string): Promise<DemoResetReport> {
  await assertDemoWorkspace(service, workspaceId)

  const { data: memberRows, error: memberError } = await service
    .from('member')
    .select('id, user_id, role, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
  if (memberError) throw new Error(`member: ${memberError.message}`)
  const members = (memberRows ?? []) as Array<{ id: string; user_id: string; role: string }>
  const owner = members.find((m) => m.role === 'owner')
  if (!owner) throw new DemoResetRefused('refusing: the demo workspace has no owner to seed as')

  const { cleared, failed } = await wipeVisitorContent(service, workspaceId)

  let seeded = false
  let seedError: string | null = null
  try {
    const ctx = await loadSeedContext(service, { workspaceId, userId: owner.user_id, memberId: owner.id })
    // Anything seeded that the wipe could not take (a table that refused).
    await resetSeeded(ctx)
    const { error: nameError } = await service.from('workspace').update({ name: WORKSPACE_NAME }).eq('id', workspaceId)
    if (nameError) throw new Error(`workspace: ${nameError.message}`)
    await seedDemoContent(ctx)
    await seedDeals(ctx)
    await seedTeamChat(ctx)
    seeded = true
  } catch (err) {
    seedError = err instanceof Error ? err.message : String(err)
  }

  // A member's own contact card may have been edited away; make sure each has one.
  for (const m of members) {
    try {
      const { data } = await service.auth.admin.getUserById(m.user_id)
      if (data?.user) {
        await ensureMemberContact(workspaceId, m.id, {
          id: data.user.id,
          email: data.user.email ?? undefined,
          user_metadata: data.user.user_metadata ?? undefined,
        })
      }
    } catch (err) {
      console.error('[demo-reset] member contact failed:', err instanceof Error ? err.message : err)
    }
  }

  await service.from('demo_workspace').update({ last_reset_at: new Date().toISOString() }).eq('workspace_id', workspaceId)
  clearDemoWorkspaceCache()

  return { workspaceId, cleared, failed, seeded, seedError, members: members.length }
}
