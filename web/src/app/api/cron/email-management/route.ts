import { getServiceClient } from '@/lib/admin'
import { syncEmailThreads, linkThreadsToContacts } from '@/lib/crm/email-sync'
import { generateEmailDrafts, REPLY_DRAFT_LABEL, type DraftProgressEvent } from '@/lib/crm/email-drafts'
import { decayRelationshipStrength } from '@/lib/crm/contacts'
import { runContactDeduplication } from '@/lib/crm/contact-dedup'
import { checkContactFollowups } from '@/lib/crm/contact-followups'
import { requireCronSecret } from '@/lib/api-auth'
import { startWork, type WorkHandle } from '@/lib/work/recorder'
import { WORK_KINDS, type WorkDeliverable } from '@/lib/work/types'
import { emailPassTeammateId } from '@/lib/work/system-teammates'
import { agentPausedCache } from '@/lib/work/agent-paused'
import { recordDraftPassEvents } from '@/lib/agent-events/email'
import {
  SAFETY_NET_LOOKBACK_MS,
  SAFETY_NET_MARGIN_MS,
  askedThreads,
  unsureReasons,
  dailyCapCheck,
  draftingBlocked,
  remainingAutoDrafts,
} from '@/lib/email/arrival-drafts'
import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * Daily CRM/email housekeeping: a full metadata thread refresh per user, plus
 * relationship decay, follow-up reminders, and the drafting safety net.
 *
 * Near-real-time freshness comes from push webhooks (Gmail Pub/Sub, Graph
 * subscriptions); there is no polling sync. New mail is drafted on arrival
 * (src/lib/email/arrival-drafts.ts). This pass drafts only what arrival
 * missed (a push that never came, a triage that failed): threads that need a
 * reply, have no open draft and whose newest message is older than
 * SAFETY_NET_MARGIN_MS but not older than SAFETY_NET_LOOKBACK_MS, through the
 * same gates and the same daily cap.
 *
 * Exposed as GET because the server's cron issues GET requests; POST is kept for
 * manual/legacy invocation.
 */
async function run() {
  const results = await Promise.allSettled([
    syncAllUsersEmail(),
    decayRelationshipStrength(),
    checkContactFollowups(getServiceClient()),
    dedupeAllWorkspaces(),
  ])

  // A rejected job is reported as 'error' in the body below; log the reason so
  // a job that keeps failing every day leaves a trace.
  const jobs = ['email_sync', 'relationship_decay', 'followup_reminders', 'contact_dedup']
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[email-management] ${jobs[i]} failed:`, r.reason)
  })

  return NextResponse.json({
    ok: true,
    email_sync: results[0].status === 'fulfilled' ? results[0].value : 'error',
    relationship_decay: results[1].status === 'fulfilled' ? 'done' : 'error',
    followup_reminders: results[2].status === 'fulfilled' ? results[2].value : 'error',
    contact_dedup: results[3].status === 'fulfilled' ? results[3].value : 'error',
  })
}

/**
 * Automatically merge duplicate contacts across every workspace. Runs the
 * deterministic dedup engine (no LLM) once a day; high-confidence clusters are
 * merged, weaker matches are left for the per-contact "Possible duplicates" UI.
 */
async function dedupeAllWorkspaces(): Promise<{ workspaces: number; merged: number }> {
  const supabaseAdmin = getServiceClient()

  // Paged: PostgREST caps one response at 1000 rows, so a single read would
  // only ever see the workspaces in the first 1000 contacts.
  const PAGE_SIZE = 1000
  const seen = new Set<string>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: rows } = await supabaseAdmin
      .from('contact')
      .select('workspace_id')
      .is('merged_into_contact_id', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    for (const r of rows || []) seen.add(r.workspace_id as string)
    if (!rows || rows.length < PAGE_SIZE) break
  }

  const workspaceIds = [...seen]
  let totalMerged = 0

  for (const workspaceId of workspaceIds) {
    try {
      const result = await runContactDeduplication(workspaceId)
      totalMerged += result.merged
    } catch (e) {
      console.error(`Contact dedup failed for workspace ${workspaceId}:`, e)
    }
  }

  return { workspaces: workspaceIds.length, merged: totalMerged }
}

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied
  return run()
}

/**
 * One work item per (user, workspace) drafting pass (ACTIVITY-AND-REVIEW-DESIGN
 * §5): the row appears on the first thread ("Reading N threads that need a
 * reply"), steps per thread, and finishes `done` with the drafts as
 * `email_draft` deliverables. No thread → no row (an empty pass is not
 * activity). Zero drafts out of N threads → `done`, quietly.
 *
 * The drafts come through the pass's bot (bots-v4.md Phase 3; v3's decision
 * 5, changed by #614: Jev now decides which emails get a reply before any
 * automatic pass). A pass that drafted something waits on no review: a
 * routine `done` sends no notice and never makes its bot call for you; its bot
 * peeks in the done-with-deliverables tier ("I drafted three replies.", peek.ts
 * isDonePeek) until it's opened or dismissed. The drafts themselves wait in
 * Mail's Drafts.
 */
function draftPassRecorder(supabase: SupabaseClient, ctx: { workspaceId: string; memberId: string }) {
  let work: WorkHandle | null = null
  const deliverables: WorkDeliverable[] = []
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

  return {
    onProgress: async (event: DraftProgressEvent) => {
      if (event.kind === 'start') {
        work = await startWork(supabase, {
          workspaceId: ctx.workspaceId,
          memberId: ctx.memberId,
          // Who ran it: the workspace's Correspondent, else the Email drafts
          // system teammate (attribution only; system-teammates.ts). Null is fine.
          aiTeamMemberId: await emailPassTeammateId(supabase, ctx.workspaceId),
          kind: WORK_KINDS.emailDrafts,
          actor: 'loop',
          title: `Reply drafts for ${plural(event.total, 'thread')}`,
          status: 'running',
          progress: { done: 0, total: event.total },
        })
        await work.step(`Reading ${plural(event.total, 'thread')} that need a reply`)
        return
      }
      if (!work) return
      const n = event.index + 1
      if (event.kind === 'thread') {
        await work.step(`Drafting reply ${n} of ${event.total}`)
      } else if (event.kind === 'drafted') {
        deliverables.push({ type: 'email_draft', id: event.draftId, label: REPLY_DRAFT_LABEL })
        await work.step(`Drafted reply ${n} of ${event.total}`, { done: deliverables.length, total: event.total })
      } else if (event.kind === 'skipped') {
        await work.step(`Skipped thread ${n} of ${event.total}`)
      }
    },
    finish: async () => {
      if (!work) return
      if (deliverables.length === 0) {
        await work.finish({ summary: 'Nothing needed a draft' })
        return
      }
      // Done, with its drafts: no review to wait on, so no notice and no push.
      await work.finish({
        summary: `${plural(deliverables.length, 'draft')} ready to review`,
        deliverables,
      })
    },
    fail: async (message: string) => {
      if (!work) return
      await work.fail(message)
    },
  }
}

export async function POST(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied
  return run()
}

/** Most drafts one safety-net pass writes for a person (arrival does the bulk). */
const SAFETY_NET_MAX_DRAFTS = 5
/** How long, of the route's 300 s, the safety net may spend drafting across all users. */
const SAFETY_NET_DRAFTING_WINDOW_MS = 210_000

async function syncAllUsersEmail(): Promise<{ users_synced: number; drafts_generated: number }> {
  const supabaseAdmin = getServiceClient()
  const draftingDeadlineAt = Date.now() + SAFETY_NET_DRAFTING_WINDOW_MS

  // Drive the sync from the connected accounts themselves, not from an
  // arbitrary membership. The old code picked
  // each user's workspace with a limit(1) member lookup and NO ordering, so a
  // user with more than one workspace could have their mailbox synced into a
  // freshly created workspace — re-deriving their whole contact graph there.
  // Each enabled email account carries the workspace it actually belongs to, so
  // that is the workspace we sync into.
  const { data: accounts } = await supabaseAdmin
    .from('connected_account')
    .select('user_id, workspace_id')
    .eq('capability', 'email')
    .eq('is_enabled', true)

  if (!accounts?.length) return { users_synced: 0, drafts_generated: 0 }

  // Dedupe on (user_id, workspace_id): a user with two accounts in the same
  // workspace is synced once, but the same user's accounts in different
  // workspaces each drive their own sync.
  const seen = new Set<string>()
  const pairs: Array<{ userId: string; workspaceId: string }> = []
  let skippedNullWorkspace = false
  for (const account of accounts) {
    if (!account.workspace_id) {
      // A NULL workspace_id can't be scoped to a workspace — skip it (and note
      // it once) rather than falling back to an arbitrary membership.
      if (!skippedNullWorkspace) {
        console.warn('[email-management] skipping connected_account with NULL workspace_id')
        skippedNullWorkspace = true
      }
      continue
    }
    const key = `${account.user_id}:${account.workspace_id}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ userId: account.user_id, workspaceId: account.workspace_id })
  }

  let totalSynced = 0
  let totalDrafts = 0
  // The kill switch (A5, src/lib/work/agent-paused.ts): a paused workspace's
  // mail still syncs and links (they act on nothing); only drafting stops.
  // It fails CLOSED here, as arrival does (A6 review: drafting spends money);
  // a thread skipped on a blip is drafted by the next pass.
  const isPaused = agentPausedCache(supabaseAdmin, 'email_pass', { failClosed: true })

  for (const { userId, workspaceId } of pairs) {
    // The pass's ledger item, once drafting starts; settled in every exit path.
    let pass: ReturnType<typeof draftPassRecorder> | null = null
    try {
      // The mailbox owner's member row in this workspace: the drafting pass's
      // ledger item is theirs. Only `id` — member has no `metadata` column, and
      // selecting it made PostgREST refuse this read on every run, so no pass
      // ever wrote its item. A failed lookup is logged, never read as "no member".
      const { data: member, error: memberError } = await supabaseAdmin
        .from('member')
        .select('id')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (memberError) {
        console.error(
          `[email-management] member lookup failed for user ${userId} / workspace ${workspaceId}: ${memberError.message}`,
        )
      }

      // 1. Sync email threads (metadata index). Message bodies and
      // near-real-time freshness come from the webhook -> incremental-sync
      // path.
      await syncEmailThreads(userId, workspaceId, false)

      // 2. Link threads to contacts
      await linkThreadsToContacts(userId, workspaceId)

      totalSynced++

      // Fresh mail is arrival's: the safety net only looks at threads whose
      // newest message is older than the margin (drafting and reporting), and
      // drafts none older than its lookback (old mail is the person's call).
      const lastMessageBefore = new Date(Date.now() - SAFETY_NET_MARGIN_MS).toISOString()
      const lastMessageAfter = new Date(Date.now() - SAFETY_NET_LOOKBACK_MS).toISOString()
      const report = (drafts: Array<Record<string, unknown>>, reason?: string, reasons?: Record<string, string>) =>
        recordDraftPassEvents(supabaseAdmin, { userId, workspaceId, drafts, lastMessageBefore, ...(reason ? { reason } : {}), ...(reasons ? { reasons } : {}) })

      // The agent's inbox (A6) still hears what waits on a reply when a gate
      // refuses: each event names the gate. Never throws.
      if (await isPaused(workspaceId)) {
        await report([], 'paused')
        continue
      }
      const gated = await draftingBlocked(supabaseAdmin, userId, workspaceId)
      if (gated) {
        await report([], gated)
        continue
      }
      const remaining = await remainingAutoDrafts(supabaseAdmin, userId, workspaceId)
      if (remaining <= 0) {
        await report([], 'cap')
        continue
      }

      // 3. Generate drafts. Always on, with no setting (the old
      // auto_email_drafts / email_tone prefs had no writer and sat on a column
      // member doesn't have), in the person's own style: no tone is passed,
      // so the draft follows what Native Intelligence learned about how they write, and is
      // professional only when it has learned nothing (2026-10-17).
      const memberId = (member?.id as string | undefined) ?? null
      pass = memberId ? draftPassRecorder(supabaseAdmin, { workspaceId, memberId }) : null
      const result = await generateEmailDrafts(userId, workspaceId, {
        max_drafts: Math.min(SAFETY_NET_MAX_DRAFTS, remaining),
        replyIntent: 'automatic',
        // No reviewer on the 05:00 safety net: it drafts users one after
        // another inside this route's 300 s, and arrival (which reviews) has
        // already had its turn at fresh mail. Its drafts are still linted.
        review: false,
        lastMessageBefore,
        lastMessageAfter,
        allowAnother: dailyCapCheck(supabaseAdmin, userId, workspaceId),
        // The route's drafting window, shared by every user: a slow pass (a
        // person on their own ChatGPT plan, whose reply decisions take
        // seconds) stops drafting there instead of the route timing out, and
        // later users are still synced.
        deadlineAt: draftingDeadlineAt,
        ...(pass ? { onProgress: pass.onProgress } : {}),
      })
      // Finished `done` with its drafts: no review to wait on, so no notice.
      await pass?.finish()

      // Each draft, and each thread still waiting on a reply with no draft.
      const capped = result.stoppedBy === 'allowance' || (result.stoppedBy === 'max' && remaining < SAFETY_NET_MAX_DRAFTS)
      // E3: threads the gate was unsure of wait as 'unsure' (the agent asks the person first).
      await report(result.drafts ?? [], capped ? 'cap' : undefined, unsureReasons(askedThreads(result.skipped)))

      if (result.count > 0) totalDrafts += result.count
    } catch (e) {
      console.error(`Email management failed for user ${userId} / workspace ${workspaceId}:`, e)
      await pass?.fail(e instanceof Error ? e.message : 'Email drafting failed')
    }
  }

  return { users_synced: totalSynced, drafts_generated: totalDrafts }
}
