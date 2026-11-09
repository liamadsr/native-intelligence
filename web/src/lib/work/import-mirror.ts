/**
 * Initial imports in the work ledger (docs/plans/agent-orchestration-product.md
 * §1.1, Sequence row 11): the HubSpot import (`crm_sync_state`, kind
 * `crm_import`) and the Gmail / Outlook import (`email_sync_state`, kind
 * `email_import`). Only the INITIAL import is a run — it has a start, a
 * terminal and a user; incremental sync is a continuous watermark and never a
 * ledger row. Task sync (Asana / Jira / Linear) has no import at all: Native Intelligence
 * only pushes actions out, so there is nothing to mirror.
 *
 *   crm_import    one row per import run, run key `hubspot:<account>:<started>`.
 *                 The function self-chains every 50 pages; each invocation
 *                 finds the same row by that key. A re-kick after a failure
 *                 re-stamps `initial_import_started_at` (hubspot-functions.ts),
 *                 so it is a new row, not the failed one reopened.
 *   email_import  one row per import run, run key `email:<account>:<started>`.
 *                 The import is two functions (recent mail, then the one-year
 *                 backfill); the backfill finds the account's open row. Every
 *                 trigger restarts the import, so opening a row first cancels
 *                 the account's older open one ("a newer import replaced it").
 *
 * Neither import writes a failure for a thrown run (HubSpot writes one only for
 * a missing token; email never does), so a run that dies leaves its row
 * running until the ledger reaper fails it with "no report back" after
 * IMPORT_RUNNING_DEADLINE_MS without a step — which is what happened.
 *
 * Owner: the user who connected the account. Not quiet: a failed import is
 * news nothing else delivers. Teammate: its area's face (migration 318: the
 * CRM import is CRM's, the mail import Mail's; the Assistant's before), so
 * the import shows with its bot, on its page and in its bubble, and a failure
 * (the reaper's included) lands in its Notices. Attribution only; fail-soft:
 * with no face to read, the Assistant; with neither, no teammate, as before.
 *
 * Service client only; every function is fail-soft.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, startWork, type WorkHandle } from './recorder'
import { resolveMemberId } from './agent-run-mirror'
import { areaTeammateId } from './system-teammates'
import { WORK_KINDS, type WorkItem, type WorkProgress } from './types'

/** A running import row with no step for this long is failed by the reaper. */
export const IMPORT_RUNNING_DEADLINE_MS = 2 * 60 * 60_000

const DEADLINES = { running: IMPORT_RUNNING_DEADLINE_MS }

function warn(what: string, err: unknown) {
  console.warn(`[work] import mirror (${what}) failed:`, err instanceof Error ? err.message : err)
}

function countOf(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

async function step(handle: WorkHandle | null, text: string, progress?: WorkProgress): Promise<void> {
  if (!handle) return
  await handle.step(text, progress)
  await handle.flush()
}

// ── HubSpot ──────────────────────────────────────────────────────────────────

export function hubspotImportRunKey(accountId: string, startedAt: string): string {
  return `hubspot:${accountId}:${startedAt}`
}

export interface HubspotImportRef {
  accountId: string
  workspaceId: string
  userId: string
  /** The run's `initial_import_started_at`. */
  startedAt: string
}

async function hubspotHandle(supabase: SupabaseClient, ref: HubspotImportRef): Promise<WorkHandle | null> {
  const row = await findWork(supabase, { kind: WORK_KINDS.crmImport, runKey: hubspotImportRunKey(ref.accountId, ref.startedAt) })
  return row ? attachWork(supabase, row, DEADLINES) : null
}

/**
 * Open the run's row. `fresh` is true on the run's first invocation (the one
 * that stamped `initial_import_started_at`); a self-chained continuation calls
 * this too, and the run key returns the existing row without a new step.
 */
export async function openHubspotImport(supabase: SupabaseClient, ref: HubspotImportRef, fresh: boolean): Promise<void> {
  try {
    const memberId = await resolveMemberId(supabase, ref.workspaceId, ref.userId)
    if (!memberId) return
    // The CRM face brings it (migration 318; the Assistant before).
    const face = await areaTeammateId(supabase, ref.workspaceId, 'crm')
    const handle = await startWork(supabase, {
      workspaceId: ref.workspaceId,
      memberId,
      aiTeamMemberId: face,
      kind: WORK_KINDS.crmImport,
      title: 'Importing from HubSpot',
      actor: 'system',
      status: 'running',
      runKey: hubspotImportRunKey(ref.accountId, ref.startedAt),
      deadlines: DEADLINES,
      source: { provider: 'hubspot', account_id: ref.accountId },
    })
    if (fresh) await step(handle, 'Importing companies')
  } catch (err) {
    warn('open hubspot', err)
  }
}

/** "Imported 1,200 companies and 340 contacts". */
export function hubspotProgressText(companies: number, contacts: number | null): string {
  if (contacts === null) return `Imported ${countOf(companies, 'company', 'companies')}`
  return `Imported ${countOf(companies, 'company', 'companies')} and ${countOf(contacts, 'contact', 'contacts')}`
}

export async function stepHubspotImport(
  supabase: SupabaseClient,
  ref: HubspotImportRef,
  companies: number,
  contacts: number | null,
): Promise<void> {
  try {
    await step(await hubspotHandle(supabase, ref), hubspotProgressText(companies, contacts))
  } catch (err) {
    warn('step hubspot', err)
  }
}

export async function finishHubspotImport(
  supabase: SupabaseClient,
  ref: HubspotImportRef,
  companies: number,
  contacts: number,
): Promise<void> {
  try {
    const handle = await hubspotHandle(supabase, ref)
    await handle?.finish({ summary: `${hubspotProgressText(companies, contacts)} from HubSpot` })
  } catch (err) {
    warn('finish hubspot', err)
  }
}

export async function failHubspotImport(supabase: SupabaseClient, ref: HubspotImportRef, message: string): Promise<void> {
  try {
    const handle = await hubspotHandle(supabase, ref)
    await handle?.fail(message)
  } catch (err) {
    warn('fail hubspot', err)
  }
}

// ── Gmail / Outlook ──────────────────────────────────────────────────────────

export interface EmailImportRef {
  workspaceId: string
  userId: string
  provider: 'google' | 'microsoft'
  accountId?: string | null
}

/** The sync-state row's identity: the account, or (legacy rows) user + provider. */
export function emailAccountKey(ref: Pick<EmailImportRef, 'userId' | 'provider' | 'accountId'>): string {
  return ref.accountId || `${ref.userId}:${ref.provider}`
}

function mailboxName(provider: EmailImportRef['provider']): string {
  return provider === 'google' ? 'Gmail' : 'Outlook'
}

async function openEmailRows(supabase: SupabaseClient, accountKey: string): Promise<WorkItem[]> {
  const { data, error } = await supabase
    .from('tracked_job')
    .select('*')
    .eq('kind', WORK_KINDS.emailImport)
    .in('status', ['queued', 'running'])
    .eq('source->>account_key', accountKey)
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(error.message)
  return (data ?? []) as WorkItem[]
}

/** The account's current (newest open) import row. */
async function emailHandle(supabase: SupabaseClient, ref: EmailImportRef): Promise<WorkHandle | null> {
  const [row] = await openEmailRows(supabase, emailAccountKey(ref))
  return row ? attachWork(supabase, row, DEADLINES) : null
}

/** Open the run's row, canceling the account's older open one first. */
export async function openEmailImport(supabase: SupabaseClient, ref: EmailImportRef, startedAt: string): Promise<void> {
  try {
    const memberId = await resolveMemberId(supabase, ref.workspaceId, ref.userId)
    if (!memberId) return
    const accountKey = emailAccountKey(ref)
    const runKey = `email:${accountKey}:${startedAt}`
    for (const older of await openEmailRows(supabase, accountKey)) {
      if (older.run_key === runKey) continue
      await attachWork(supabase, older, DEADLINES).cancel('Restarted — a newer import replaced it')
    }
    // The Mail face brings it (migration 318; the Assistant before).
    const face = await areaTeammateId(supabase, ref.workspaceId, 'mail')
    const handle = await startWork(supabase, {
      workspaceId: ref.workspaceId,
      memberId,
      aiTeamMemberId: face,
      kind: WORK_KINDS.emailImport,
      title: `Importing ${mailboxName(ref.provider)}`,
      actor: 'system',
      status: 'running',
      runKey,
      deadlines: DEADLINES,
      source: { provider: ref.provider, account_id: ref.accountId ?? null, account_key: accountKey },
    })
    await step(handle, 'Importing the last 30 days')
  } catch (err) {
    warn('open email', err)
  }
}

export async function finishEmailImport(supabase: SupabaseClient, ref: EmailImportRef, totalMessages: number): Promise<void> {
  try {
    const handle = await emailHandle(supabase, ref)
    await handle?.finish({ summary: `Imported ${countOf(totalMessages, 'message', 'messages')} from ${mailboxName(ref.provider)}` })
  } catch (err) {
    warn('finish email', err)
  }
}
