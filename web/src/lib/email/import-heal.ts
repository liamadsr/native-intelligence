import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'

/**
 * Restarts mailbox imports that never finished, once a day (from the
 * renew-email-watches cron). Without a finished import an account has no
 * history/delta checkpoint and no push watch, so it would never sync.
 *
 * This replaces the self-heal half of the old every-5-minute email-sync cron,
 * which also polled every mailbox and cost ~17k Inngest executions per account
 * a month. Pushes (Gmail Pub/Sub, Graph subscriptions) and the Sync button now
 * carry freshness; this only unsticks imports.
 */

/** An import started within this window may simply still be running. */
export const RUNNING_GRACE_MS = 60 * 60 * 1000

export interface ImportState {
  initial_import_status: string | null
  initial_import_started_at: string | null
  gmail_history_id: string | null
  ms_delta_link: string | null
}

export function importNeedsRestart(
  provider: 'google' | 'microsoft',
  state: ImportState | null | undefined,
  now: number,
): boolean {
  if (!state) return true
  const hasCheckpoint = provider === 'google' ? !!state.gmail_history_id : !!state.ms_delta_link
  if (state.initial_import_status === 'complete' && hasCheckpoint) return false
  // The old cron re-kicked any account without a checkpoint, including one
  // whose import was still mid-fetch, so a slow import was started again and
  // again. Leave a recent one alone.
  const startedAt = state.initial_import_started_at ? Date.parse(state.initial_import_started_at) : NaN
  if (state.initial_import_status === 'importing_recent' && now - startedAt < RUNNING_GRACE_MS) return false
  return true
}

export async function restartStalledEmailImports(
  supabase: SupabaseClient = getServiceClient(),
  now: number = Date.now(),
): Promise<number> {
  const { data: accounts, error } = await supabase
    .from('connected_account')
    .select('id, user_id, workspace_id, provider')
    .eq('capability', 'email')
    .eq('is_enabled', true)
  if (error) throw new Error(`Failed to list email accounts: ${error.message}`)
  if (!accounts?.length) return 0

  const { data: states, error: statesError } = await supabase
    .from('email_sync_state')
    .select('account_id, initial_import_status, initial_import_started_at, gmail_history_id, ms_delta_link')
    .in('account_id', accounts.map((a) => a.id))
  if (statesError) throw new Error(`Failed to read email sync state: ${statesError.message}`)
  const stateByAccount = new Map((states ?? []).map((s) => [s.account_id as string, s as ImportState]))

  const day = new Date(now).toISOString().slice(0, 10)
  let restarted = 0
  for (const account of accounts) {
    const provider = account.provider as 'google' | 'microsoft'
    if (!importNeedsRestart(provider, stateByAccount.get(account.id), now)) continue
    try {
      await inngest.send({
        // Inngest drops a repeat of the same event id within 24h, so a cron
        // retry or a second run that day can't start a duplicate import.
        id: `email-import-restart-${account.id}-${day}`,
        name: 'email/initial-import',
        data: {
          accountId: account.id,
          userId: account.user_id,
          workspaceId: account.workspace_id,
          provider,
        },
      })
      restarted++
    } catch (err) {
      console.error(`[import-heal] account ${account.id} failed:`, err)
    }
  }
  return restarted
}
