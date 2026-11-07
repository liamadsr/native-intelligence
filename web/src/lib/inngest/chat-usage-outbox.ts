import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from './client'
import { getServiceClient } from '@/lib/supabase/service'
import {
  chatUsageIdempotencyKey,
  meterChatTurn,
  parseChatTurnUsageReport,
  resolveChatUsagePayer,
} from '@/lib/chat/chat-usage-meter'

/**
 * Server-side backstop for eve chat billing: drain `chat_usage_outbox`.
 *
 * The chat-agent's usage-meter hook posts each turn's report to
 * /api/internal/chat/usage. A report it could not deliver (the app down or
 * deploying past the hook's settle budget, a 409 SESSION_UNREGISTERED race, a
 * 401 secret mismatch) used to wait in the SESSION's state for a later turn's
 * end — so the session's LAST turn was never billed. The hook now writes such a
 * report to the outbox table (agents/chat-agent/lib/usage-outbox.ts, migration
 * 278) under the route's own idempotency key, and this sweep bills it with the
 * SAME logic as the route:
 *   - the report is re-validated (parseChatTurnUsageReport) and its key
 *     recomputed — a row whose key does not match its report is dropped;
 *   - WHO PAYS is resolved exactly like the route (resolveChatUsagePayer: a
 *     token whose HMAC verifies, within its grace as of the row's created_at,
 *     else the eve session's owner) — never from the row's claims;
 *   - the bill goes through meterChatTurn → log_ai_usage_once with that key,
 *     so a turn the route (or an earlier sweep) already billed is a no-op.
 *
 * Rows are only touched once they are OUTBOX_MIN_AGE_MS old, so the hook's own
 * in-session re-send gets the first chance. A settled row (billed, duplicate,
 * empty, surface) is deleted. An unregistered session is retried until
 * OUTBOX_MAX_AGE_MS, then dropped with a Sentry error (unbillable: no verified
 * token, no owner). A bill that failed stays for the next sweep.
 *
 * Rows are taken FEWEST ATTEMPTS first, then oldest: a retained row's attempts
 * grow with every sweep, so a backlog of stuck rows (an unregistered session,
 * a failing payer lookup, a lost bill) rotates behind newer rows instead of
 * filling every OUTBOX_BATCH and starving a fresh undelivered turn. Nothing
 * billable is dropped for its attempt count — only the 24h unattributable rule
 * and a malformed report drop a row.
 *
 * Any sweep that BILLS something alerts Sentry (warning): it means the hook's
 * direct path failed for that turn, which should be rare and worth seeing.
 */

/** Leave a row this long before sweeping it (the hook's own re-send first). */
export const OUTBOX_MIN_AGE_MS = 2 * 60 * 1000
/** An unattributable row is dropped (and alerted) after this long. */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Rows per sweep (the next tick takes the rest). */
export const OUTBOX_BATCH = 100

interface OutboxRow {
  idempotency_key: string
  report: unknown
  run_token: string | null
  attempts: number | null
  created_at: string
}

export interface OutboxSweepResult {
  scanned: number
  billed: number
  settled: number
  retained: number
  dropped: number
}

async function deleteRow(supabase: SupabaseClient, key: string): Promise<void> {
  const { error } = await supabase.from('chat_usage_outbox').delete().eq('idempotency_key', key)
  if (error) console.error(`[chat usage outbox] delete failed for ${key}: ${error.message}`)
}

async function retain(supabase: SupabaseClient, row: OutboxRow, reason: string): Promise<void> {
  const { error } = await supabase
    .from('chat_usage_outbox')
    .update({ attempts: (row.attempts ?? 0) + 1, last_error: reason.slice(0, 500) })
    .eq('idempotency_key', row.idempotency_key)
  if (error) console.error(`[chat usage outbox] update failed for ${row.idempotency_key}: ${error.message}`)
}

/**
 * One sweep over the oldest eligible outbox rows. Never throws on a row (each
 * is settled, retained or dropped on its own); throws only when the listing
 * itself fails, so Inngest retries the run.
 */
export async function sweepChatUsageOutbox(supabase: SupabaseClient, now = Date.now()): Promise<OutboxSweepResult> {
  const result: OutboxSweepResult = { scanned: 0, billed: 0, settled: 0, retained: 0, dropped: 0 }
  const { data, error } = await supabase
    .from('chat_usage_outbox')
    .select('idempotency_key, report, run_token, attempts, created_at')
    .lt('created_at', new Date(now - OUTBOX_MIN_AGE_MS).toISOString())
    .order('attempts', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(OUTBOX_BATCH)
  if (error) throw new Error(`chat usage outbox: listing failed: ${error.message}`)
  const rows = (data ?? []) as OutboxRow[]
  result.scanned = rows.length

  for (const row of rows) {
    const parsed = parseChatTurnUsageReport(row.report)
    if (!parsed.ok || chatUsageIdempotencyKey(parsed.report) !== row.idempotency_key) {
      Sentry.captureMessage('chat usage outbox: dropped a malformed report', {
        level: 'error',
        tags: { area: 'billing', op: 'chat_usage_outbox' },
        extra: { key: row.idempotency_key, error: parsed.ok ? 'key mismatch' : parsed.error },
      })
      await deleteRow(supabase, row.idempotency_key)
      result.dropped += 1
      continue
    }
    try {
      // The token speaks for the turn as of when the hook queued the report,
      // not when this sweep reaches it (rows wait up to OUTBOX_MAX_AGE_MS).
      const queuedAt = Date.parse(row.created_at)
      const resolved = await resolveChatUsagePayer(supabase, row.run_token, parsed.report, Number.isFinite(queuedAt) ? queuedAt : now)
      if (resolved.kind === 'surface') {
        await deleteRow(supabase, row.idempotency_key)
        result.settled += 1
        continue
      }
      if (resolved.kind === 'unregistered') {
        const age = now - Date.parse(row.created_at)
        if (Number.isFinite(age) && age > OUTBOX_MAX_AGE_MS) {
          Sentry.captureMessage('chat usage outbox: dropped an unattributable report (no verified token, no session owner)', {
            level: 'error',
            tags: { area: 'billing', op: 'chat_usage_outbox' },
            extra: { key: row.idempotency_key, inputTokens: parsed.report.inputTokens, outputTokens: parsed.report.outputTokens },
          })
          await deleteRow(supabase, row.idempotency_key)
          result.dropped += 1
        } else {
          await retain(supabase, row, 'session unregistered')
          result.retained += 1
        }
        continue
      }
      const metered = await meterChatTurn(resolved.payer, parsed.report)
      if (metered.billed) result.billed += 1
      else result.settled += 1
      await deleteRow(supabase, row.idempotency_key)
    } catch (err) {
      await retain(supabase, row, err instanceof Error ? err.message : String(err))
      result.retained += 1
    }
  }

  if (result.billed > 0) {
    Sentry.captureMessage('chat usage outbox billed turns the usage-meter hook could not deliver', {
      level: 'warning',
      tags: { area: 'billing', op: 'chat_usage_outbox' },
      extra: { ...result },
    })
  }
  return result
}

export const chatUsageOutboxSweep = inngest.createFunction(
  {
    id: 'billing-chat-usage-outbox-sweep',
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '*/10 * * * *' }],
  },
  async ({ step }) => step.run('sweep-outbox', () => sweepChatUsageOutbox(getServiceClient())),
)
