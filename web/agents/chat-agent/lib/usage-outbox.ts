/**
 * The usage meter's durable backstop: a report the hook could not deliver to
 * POST /api/internal/chat/usage is written to `chat_usage_outbox` (migration
 * 278), and the Next app's sweeper (src/lib/inngest/chat-usage-outbox.ts) bills
 * it through the SAME route logic under the SAME idempotency key.
 *
 * Why here and not a server-side stream re-read: the chat-agent channel admits
 * no internal-secret principal (a server secret never skips the session
 * ownership ACL), so the Next app cannot read a session's stream after the fact
 * without the user's own credential. The runtime that produced the numbers
 * writes them straight to the database instead. That also covers the cases the
 * in-session re-send cannot: the session's LAST turn (no later turn.* event),
 * an app outage or deploy longer than one settle budget, a 409
 * SESSION_UNREGISTERED race, and a secret mismatch (401) — the database write
 * does not go through the app or its secret.
 *
 * Trust: the row is written by our own runtime with the service role (the same
 * credential the channel's ACL lookup uses); the table is service-role only.
 * WHO PAYS is still never taken from the row: the sweeper resolves it exactly
 * like the route (a token whose HMAC verifies, else the session's owner).
 *
 * Never throws: returns the reports it could NOT write (the hook keeps those in
 * its pending queue, as before).
 */
import { createClient } from '@supabase/supabase-js'
import type { TurnUsageReport } from './turn-usage.js'

/** Per-write ceiling (the hook runs at a turn's end; it must not stall it). */
export const OUTBOX_WRITE_TIMEOUT_MS = 5_000

export const CHAT_USAGE_OUTBOX_TABLE = 'chat_usage_outbox'

/**
 * The route's idempotency key for a report — TWIN of chatUsageIdempotencyKey in
 * src/lib/chat/chat-usage-meter.ts (this eve root cannot import it; a drift
 * test pins the two). Feature key 'ai_chat' byte-identical.
 */
export function usageReportKey(report: Pick<TurnUsageReport, 'sessionId' | 'turnId' | 'compaction'>): string {
  const base = `ai_chat:${report.sessionId}:${report.turnId}`
  return report.compaction ? `${base}:compaction:${report.compaction.id}` : base
}

function outboxClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

/**
 * Write `reports` to the outbox (a key already there is left as is). Returns
 * the reports that were NOT written. `runToken` rides along so the sweeper can
 * attribute a session no conversation registers (it verifies the HMAC; it
 * never trusts the row's claims).
 */
export async function writeUsageOutbox(reports: TurnUsageReport[], runToken: string): Promise<TurnUsageReport[]> {
  if (reports.length === 0) return []
  try {
    const client = outboxClient()
    if (!client) {
      console.error('[chat-agent] usage outbox unavailable: Supabase service env is not set')
      return reports
    }
    const rows = reports.map((r) => ({
      idempotency_key: usageReportKey(r),
      session_id: r.sessionId,
      turn_id: r.turnId,
      report: r,
      run_token: runToken || null,
    }))
    const { error } = await client
      .from(CHAT_USAGE_OUTBOX_TABLE)
      .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .abortSignal(AbortSignal.timeout(OUTBOX_WRITE_TIMEOUT_MS))
    if (error) {
      console.error(`[chat-agent] usage outbox write failed: ${error.message}`)
      return reports
    }
    console.warn(`[chat-agent] ${reports.length} usage report(s) handed to the outbox for the server-side sweep`)
    return []
  } catch (err) {
    console.error(`[chat-agent] usage outbox write threw: ${err instanceof Error ? err.message : String(err)}`)
    return reports
  }
}
