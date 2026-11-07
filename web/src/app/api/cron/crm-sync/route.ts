import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { requireCronSecret } from '@/lib/api-auth'

export const maxDuration = 60

/**
 * GET /api/cron/crm-sync
 *
 * Every 15 min, keeps connected HubSpot CRM accounts fresh. HubSpot has no push
 * webhook wired into Dial8, so this cron is the sole freshness driver: for every
 * enabled `capability = 'crm'` account it either advances the incremental sync
 * or self-heals a stalled/never-finished initial import.
 *
 * Native Inngest cron triggers are BANNED in this codebase — the mandated
 * pattern is vercel.json cron → inngest.send (see cron/weave/route.ts). This
 * route only dispatches events; the heavy lifting is in hubspot-functions.ts.
 *
 * Dispatch matrix per account (read from crm_sync_state):
 *   - complete + watermark            → crm/hubspot-incremental-sync
 *   - missing state / pending / failed → crm/hubspot-initial-import (create the
 *                                         state row first when missing)
 *   - importing_companies / importing_contacts → skip (already running)
 *
 * Accounts whose workspace has OPTED IN to contact push additionally get a
 * best-effort crm/hubspot-push-sweep: a cheap catch-all so a retroactive contact
 * backfill that fell out of an earlier retry window (or whose enable-time fire
 * was dropped) still eventually runs. The opt-in is read here, from one batched
 * `workspace` query over the touched workspace ids, rather than fanning an event
 * at every HubSpot workspace every 15 min and letting the sweep fn no-op: the
 * flag is off for nearly every workspace, so the unfiltered version spends the
 * whole fleet's worth of Inngest runs to learn nothing. The sweep fn keeps its
 * own toggle guard as defence-in-depth (the flag can flip between this read and
 * the run). One event per WORKSPACE, not per account — the sweep is
 * workspace-scoped (debounced + concurrency-keyed on workspaceId), so two
 * accounts in one workspace would only collapse into the same run anyway.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()

  // All enabled CRM accounts (multi-account aware).
  const { data: accounts, error } = await supabase
    .from('connected_account')
    .select('id, user_id, workspace_id, provider')
    .eq('capability', 'crm')
    .eq('is_enabled', true)

  if (error) {
    console.error('[crm-sync cron] failed to list accounts:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let incremental = 0
  let reimport = 0
  let sweep = 0

  // Candidate workspaces for the retroactive contact-push sweep, collected
  // during the dispatch loop and filtered by the opt-in flag afterwards (one
  // batched settings query for the whole set — see below). A Set because the
  // sweep is per-workspace, not per-account.
  const sweepWorkspaceIds = new Set<string>()

  for (const account of accounts || []) {
    try {
      const { data: state } = await supabase
        .from('crm_sync_state')
        .select('initial_import_status, sync_watermark, workspace_id')
        .eq('account_id', account.id)
        .maybeSingle()

      // Note the account's workspace as a sweep candidate. Uses the state row's
      // workspace_id when present (canonical), else the account's. Whether it
      // actually gets an event depends on the opt-in check after the loop.
      const sweepWorkspaceId =
        (state?.workspace_id as string | undefined) ?? account.workspace_id
      if (sweepWorkspaceId) {
        sweepWorkspaceIds.add(sweepWorkspaceId)
      }

      const importComplete = state?.initial_import_status === 'complete'
      const hasWatermark = !!state?.sync_watermark

      if (importComplete && hasWatermark) {
        // Normal path: pull anything modified since the stored watermark.
        await inngest.send({
          name: 'crm/hubspot-incremental-sync',
          data: {
            accountId: account.id,
            userId: account.user_id,
            workspaceId: account.workspace_id,
          },
        })
        incremental++
      } else if (
        !state ||
        state.initial_import_status === 'pending' ||
        state.initial_import_status === 'failed'
      ) {
        // Self-heal: the first import never finished (Inngest dropped the event,
        // errored, or the account was connected before sync state existed).
        // Create the state row when missing so the incremental path has
        // somewhere to record the watermark once the import completes.
        if (!state) {
          await supabase
            .from('crm_sync_state')
            .upsert(
              {
                account_id: account.id,
                user_id: account.user_id,
                workspace_id: account.workspace_id,
                provider: 'hubspot',
                initial_import_status: 'pending',
              },
              { onConflict: 'account_id', ignoreDuplicates: true },
            )
        }
        await inngest.send({
          name: 'crm/hubspot-initial-import',
          data: {
            accountId: account.id,
            userId: account.user_id,
            workspaceId: account.workspace_id,
          },
        })
        reimport++
      }
      // status 'importing_companies' / 'importing_contacts' => running, skip.
    } catch (err) {
      console.error(`[crm-sync cron] account ${account.id} failed:`, err)
    }
  }

  // Retroactive contact-push sweep — ONLY for workspaces that turned it on.
  // `push_contacts_to_hubspot` is a default-absent-false opt-in, so this is a
  // hard filter, not a hint: without it every HubSpot workspace burns a sweep
  // run every 15 min to discover its own flag is off. One batched read over the
  // workspaces touched above; a failure here is logged and skipped (the sync
  // dispatches already happened and must not be reported as a cron failure).
  if (sweepWorkspaceIds.size > 0) {
    const { data: workspaces, error: settingsError } = await supabase
      .from('workspace')
      .select('id, settings')
      .in('id', [...sweepWorkspaceIds])

    if (settingsError) {
      console.error('[crm-sync cron] failed to load workspace push settings:', settingsError)
    } else {
      for (const workspace of workspaces || []) {
        const settings = (workspace.settings ?? {}) as Record<string, unknown>
        if (settings.push_contacts_to_hubspot !== true) continue
        try {
          // No includeFailed: routine ticks must not re-walk contacts whose push
          // permanently failed (401 → metadata.hubspot_push_error). Retrying
          // those is the settings PATCH's job, after a reconnect.
          await inngest.send({
            name: 'crm/hubspot-push-sweep',
            data: { workspaceId: workspace.id },
          })
          sweep++
        } catch (err) {
          console.error(`[crm-sync cron] push sweep for workspace ${workspace.id} failed:`, err)
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    accounts: accounts?.length || 0,
    incremental_synced: incremental,
    reimport_triggered: reimport,
    push_sweep_triggered: sweep,
  })
}
