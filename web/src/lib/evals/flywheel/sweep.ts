/**
 * The evals flywheel's sweep stages (run every 30 minutes by
 * src/lib/inngest/eval-flywheel.ts), each on the service client:
 *
 *   chat   assistant `chat_messages` written in the last SWEEP_WINDOW_MS whose
 *          tool path hit REPEATED_FAILURE or INPUT_INVALID: one candidate per
 *          message per code (evalCandidateKey.chatFailure).
 *   loops  `tracked_job` rows that FAILED in the window, minus the failures
 *          that say nothing about the agent (loop-evidence.ts loopSkipReason)
 *          and the kinds no agent runs (NON_AGENT_JOB_KINDS): one candidate
 *          per job (evalCandidateKey.loop).
 *   purge  dismissed rows after DISMISSED_TTL_DAYS, unreviewed (`new`) rows
 *          after NEW_TTL_DAYS. Promoted and exported rows stay.
 *
 * The window is three times the cadence, so a late or skipped pass loses
 * nothing. Each stage pages through its window OLDEST first, SCAN_PAGE_SIZE
 * rows a read, and checks each page's dedupe keys against what is already
 * recorded: those rows are passed over without spending anything
 * (recordEvalCandidate's 'skip' mode backs that up). A pass records at most
 * RECORD_BUDGET new candidates per stage and reads at most SCAN_PAGES pages
 * per query; whatever it leaves is newer than what it did, so the next pass
 * (its window still covering it) picks up where this one stopped. Only a
 * window that stays past the caps for its whole 90 minutes loses its oldest
 * overflow. Stages return counts only; nothing here logs content.
 *
 * Narrowing the chat scan: three jsonb containment reads (a part in
 * `output-error`, a part whose output's code is REPEATED_FAILURE, one whose
 * code is INPUT_INVALID), so only messages that can carry a code come back.
 * `chat_messages` has no created_at index of its own, so each read scans the
 * table under the window filter: fine at today's size; an index on
 * (created_at) where role = 'assistant' is the fix when it grows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildChatTurnEvidence, failureCodesOf, loadRequestMessage, serverStartedRequest, type ChatFailureCode, type StoredChatMessage } from './chat-evidence'
import { loadLoopContext, loopEvidenceFrom, loopSkipReason, type FailedJobRow } from './loop-evidence'
import { recordEvalCandidate, type RecordOutcome } from './record'
import { evalCandidateKey, type EvalCandidateSource } from './types'

/** How far back a pass looks (three passes of 30 minutes). */
export const SWEEP_WINDOW_MS = 90 * 60 * 1000
/** Rows per read; reads per query per pass; new candidates per stage per pass (see the module header). */
export const SCAN_PAGE_SIZE = 200
export const SCAN_PAGES = 10
export const RECORD_BUDGET = 200
/** How long a dismissed row, and an unreviewed one, is kept. */
export const DISMISSED_TTL_DAYS = 30
export const NEW_TTL_DAYS = 90

/**
 * Ledger kinds no agent runs: a mirror of a non-agent pipeline (a sequence
 * send, an enrichment or import sweep, an eval trial run) or a housekeeping
 * cron. Their failures are infrastructure, not a test case.
 */
export const NON_AGENT_JOB_KINDS: ReadonlySet<string> = new Set([
  'eval',
  'sequence_enrolment',
  'crm_enrichment',
  'crm_import',
  'email_import',
  'triage_reconcile',
  'proposal_age_out',
])

/** The containment filters the chat scan reads (see the module header). */
export const CHAT_FAILURE_FILTERS: ReadonlyArray<Record<string, unknown>> = [
  { parts: [{ state: 'output-error' }] },
  { parts: [{ output: { code: 'REPEATED_FAILURE' } }] },
  { parts: [{ output: { code: 'INPUT_INVALID' } }] },
]

const SOURCE_OF_CODE: Record<ChatFailureCode, EvalCandidateSource> = {
  REPEATED_FAILURE: 'repeated_failure',
  INPUT_INVALID: 'input_invalid',
}

export interface StageCounts {
  scanned: number
  /** Signals found (a message's code, a failed job that counts). */
  found: number
  inserted: number
  /** Already recorded (an earlier pass's overlap, or a reviewed row). */
  known: number
  /** Passed over: a skip rule, an unknown owner, no message id. */
  passed: number
  failed: number
}

const zero = (): StageCounts => ({ scanned: 0, found: 0, inserted: 0, known: 0, passed: 0, failed: 0 })

function tally(counts: StageCounts, outcome: RecordOutcome): void {
  if (outcome === 'inserted') counts.inserted += 1
  else if (outcome === 'failed') counts.failed += 1
  else counts.known += 1
}

const ident = (workspaceId: string, userId: string, key: string) => `${workspaceId}|${userId}|${key}`

/** The (workspace, user, key) triples already recorded among `keys`. Empty on a failed read (record() still dedupes). */
async function knownKeys(supabase: SupabaseClient, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await supabase
      .from('eval_candidate')
      .select('workspace_id, user_id, dedupe_key')
      .in('dedupe_key', keys.slice(i, i + 100))
    if (error || !Array.isArray(data)) continue
    for (const r of data as Array<{ workspace_id: string; user_id: string; dedupe_key: string }>) out.add(ident(r.workspace_id, r.user_id, r.dedupe_key))
  }
  return out
}

interface ChatRow extends StoredChatMessage {
  id: string
  conversation_id: string
  user_id: string
  workspace_id: string
}

/**
 * Page through a query oldest first: `read(from, to)` is one page. Stops at a
 * short page, a failed read (logged as `what`), SCAN_PAGES pages, or when
 * `onPage` answers false (the budget is spent).
 */
async function pageOldestFirst<T>(
  what: string,
  read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  onPage: (rows: T[]) => Promise<boolean>,
): Promise<void> {
  for (let page = 0; page < SCAN_PAGES; page++) {
    const from = page * SCAN_PAGE_SIZE
    const { data, error } = await read(from, from + SCAN_PAGE_SIZE - 1)
    if (error) {
      console.error(`[eval-flywheel] ${what} scan failed:`, error.message)
      return
    }
    const rows = (Array.isArray(data) ? data : []) as T[]
    if (rows.length && !(await onPage(rows))) return
    if (rows.length < SCAN_PAGE_SIZE) return
  }
}

/** Stage chat: REPEATED_FAILURE / INPUT_INVALID turns in the window. */
export async function sweepChatFailures(supabase: SupabaseClient, now: number = Date.now()): Promise<StageCounts> {
  const counts = zero()
  const since = new Date(now - SWEEP_WINDOW_MS).toISOString()
  // A message can match more than one filter: each is handled once.
  const seen = new Set<string>()
  let budget = RECORD_BUDGET

  const onPage = async (page: ChatRow[]): Promise<boolean> => {
    const flagged: Array<{ row: ChatRow; messageId: string; codes: ChatFailureCode[] }> = []
    for (const row of page) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      counts.scanned += 1
      const messageId = row.ui_message_id ?? ''
      const codes = failureCodesOf(buildChatTurnEvidence(row, null).evidence)
      if (!codes.length) continue
      counts.found += codes.length
      if (!messageId || !row.workspace_id || !row.user_id) {
        counts.passed += codes.length
        continue
      }
      flagged.push({ row, messageId, codes })
    }
    if (!flagged.length) return true

    const known = await knownKeys(supabase, flagged.flatMap((f) => f.codes.map((c) => evalCandidateKey.chatFailure(f.messageId, c))))
    for (const { row, messageId, codes } of flagged) {
      const fresh = codes.filter((c) => !known.has(ident(row.workspace_id, row.user_id, evalCandidateKey.chatFailure(messageId, c))))
      counts.known += codes.length - fresh.length
      if (!fresh.length) continue
      // Spent: what is left is newer, and the next pass's window still holds it.
      if (budget <= 0) return false
      const request =
        row.created_at && !serverStartedRequest(row.ui_message)
          ? await loadRequestMessage(supabase, { conversationId: row.conversation_id, userId: row.user_id, before: row.created_at })
          : null
      const turn = buildChatTurnEvidence(row, request)
      for (const code of fresh) {
        budget -= 1
        tally(
          counts,
          await recordEvalCandidate(supabase, {
            workspaceId: row.workspace_id,
            userId: row.user_id,
            source: SOURCE_OF_CODE[code],
            dedupeKey: evalCandidateKey.chatFailure(messageId, code),
            evidence: turn.evidence,
            refType: 'chat_message',
            refId: messageId,
            conversationId: row.conversation_id,
            skillSlugs: turn.skillSlugs,
            tools: turn.tools,
            onExisting: 'skip',
          }),
        )
      }
    }
    return budget > 0
  }

  for (const filter of CHAT_FAILURE_FILTERS) {
    if (budget <= 0) break
    await pageOldestFirst<ChatRow>(
      'chat',
      (from, to) =>
        supabase
          .from('chat_messages')
          .select('id, conversation_id, user_id, workspace_id, role, ui_message, ui_message_id, created_at')
          .eq('role', 'assistant')
          .gte('created_at', since)
          .contains('ui_message', filter)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      onPage,
    )
  }
  return counts
}

/** Stage loops: jobs that failed in the window, for a reason that says something about the agent. */
export async function sweepFailedJobs(supabase: SupabaseClient, now: number = Date.now()): Promise<StageCounts> {
  const counts = zero()
  const since = new Date(now - SWEEP_WINDOW_MS).toISOString()
  let budget = RECORD_BUDGET

  const onPage = async (jobs: FailedJobRow[]): Promise<boolean> => {
    counts.scanned += jobs.length
    const counting = jobs.filter((j) => !NON_AGENT_JOB_KINDS.has(j.kind) && loopSkipReason(j) === null)
    counts.found += counting.length
    counts.passed += jobs.length - counting.length
    if (!counting.length) return true

    // Which of them an earlier pass recorded (keys are per job, so a bare key read suffices).
    const knownByKey = new Set([...(await knownKeys(supabase, counting.map((j) => evalCandidateKey.loop(j.id))))].map((k) => k.split('|')[2]))
    const fresh = counting.filter((j) => !knownByKey.has(evalCandidateKey.loop(j.id)))
    counts.known += counting.length - fresh.length
    if (!fresh.length) return true

    // Spent part-way: the rest is newer, and the next pass's window still holds it.
    const taken = fresh.slice(0, budget)
    const context = await loadLoopContext(supabase, taken)
    for (const job of taken) {
      const userId = context.users.get(job.member_id)
      if (!userId) {
        counts.passed += 1
        continue
      }
      budget -= 1
      const { evidence, skill } = loopEvidenceFrom(job, context)
      tally(
        counts,
        await recordEvalCandidate(supabase, {
          workspaceId: job.workspace_id,
          userId,
          source: 'loop_failed',
          dedupeKey: evalCandidateKey.loop(job.id),
          evidence,
          refType: 'tracked_job',
          refId: job.id,
          skillSlugs: skill ? [skill] : [],
          onExisting: 'skip',
        }),
      )
    }
    return budget > 0
  }

  await pageOldestFirst<FailedJobRow>(
    'job',
    (from, to) =>
      supabase
        .from('tracked_job')
        .select('id, workspace_id, member_id, kind, title, status, error_message, source, agent_run_id, flow_run_id, finished_at')
        .eq('status', 'failed')
        .gte('finished_at', since)
        .order('finished_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    onPage,
  )
  return counts
}

export interface PurgeCounts {
  dismissed: number
  stale: number
}

/**
 * Stage purge: dismissed rows reviewed more than DISMISSED_TTL_DAYS ago (a
 * row dismissed without a review stamp goes by its last update), and `new`
 * rows created more than NEW_TTL_DAYS ago.
 */
export async function purgeCandidates(supabase: SupabaseClient, now: number = Date.now()): Promise<PurgeCounts> {
  const day = 24 * 60 * 60 * 1000
  const dismissedBefore = new Date(now - DISMISSED_TTL_DAYS * day).toISOString()
  const newBefore = new Date(now - NEW_TTL_DAYS * day).toISOString()
  const removed = async (run: () => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<number> => {
    const { data, error } = await run()
    if (error) {
      console.error('[eval-flywheel] purge failed:', error.message)
      return 0
    }
    return Array.isArray(data) ? data.length : 0
  }
  const reviewed = await removed(() =>
    supabase.from('eval_candidate').delete().eq('status', 'dismissed').lt('reviewed_at', dismissedBefore).select('id'),
  )
  const unstamped = await removed(() =>
    supabase.from('eval_candidate').delete().eq('status', 'dismissed').is('reviewed_at', null).lt('updated_at', dismissedBefore).select('id'),
  )
  const stale = await removed(() => supabase.from('eval_candidate').delete().eq('status', 'new').lt('created_at', newBefore).select('id'))
  return { dismissed: reviewed + unstamped, stale }
}
