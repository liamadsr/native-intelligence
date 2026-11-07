import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { HUBSPOT_PUSH_ERROR_KEY, HUBSPOT_SOURCE_PROVIDER } from '@/lib/crm/hubspot-sync'
import { HUBSPOT_PUSH_HOLD_KEY } from '@/lib/crm/hubspot-push-hold'

// =====================================================================
// HubSpot contact-push RETROACTIVE SWEEP
//
// Enabling contact push (or widening its scope 'manual'→'all') should mirror the
// contacts that ALREADY exist in the workspace, not just future ones. This
// function is the backfill: it pages the workspace's eligible contacts and fans
// out one crm/hubspot-push-contact event per contact. The per-contact function
// (hubspot-push-contact.ts) remains the sole authority on gating, dedupe, and
// the compare-and-swap link — the sweep only decides WHICH rows to poke.
//
// Triggered by crm/hubspot-push-sweep {workspaceId, includeFailed?} from:
//   - the hubspot-settings PATCH (toggle false→true, or scope 'manual'→'all'),
//     which passes includeFailed: true — an operator turning push on (or widening
//     it) is exactly the moment to retry contacts that failed permanently before,
//     since it usually follows a HubSpot reconnect that granted the write scope.
//   - the crm-sync cron (per opted-in workspace — a cheap catch-all so a sweep
//     that fell out of an earlier retry window still eventually runs). The cron
//     omits includeFailed: routine ticks must never re-walk known-dead rows.
//
// Idempotency & safety:
//   - Guards: master toggle ON + a crm_sync_state row exists for the workspace
//     (i.e. HubSpot is actually connected). Either absent → clean no-op, so a
//     spurious fire (e.g. a stale event for a workspace that has since disabled
//     push) costs nothing. The cron additionally pre-filters on the toggle, so
//     this guard is defence-in-depth rather than the primary filter.
//   - The eligibility query filters `source_provider IS NULL` — rows the read-
//     sync or a prior push already linked are skipped — and the per-contact fn
//     re-checks everything and is invocation-idempotent on contactId. Together
//     these make re-sweeps safe: a second sweep re-emits only the still-unlinked
//     remainder, and even a duplicate emit collapses in the per-contact fn.
//   - PERMANENT FAILURES: a contact whose push 401'd never gets source_provider
//     set, so `source_provider IS NULL` alone would re-emit it every tick,
//     forever. hubspot-push-contact stamps such rows with
//     metadata.hubspot_push_error; the routine sweep EXCLUDES them and only an
//     includeFailed sweep re-admits them.
//   - Keyset pagination on (created_at, id) via a cursor carried in the event
//     data, batch 100, capped at MAX_PAGES_PER_RUN pages; if more remain the fn
//     self-chains (mirrors hubspotInitialImport) so each invocation stays
//     bounded for large workspaces. The continuation carries includeFailed so a
//     retry sweep keeps retrying across every page, not just the first.
//
// STEP STRUCTURE (load-bearing — do not "simplify" this back):
//   The page loop runs at the FUNCTION level. Each iteration is exactly one
//   `step.run('sweep-page-N')` that ONLY runs the eligibility query and returns
//   the rows; the fan-out `step.sendEvent('push-batch-N', ...)` happens at the
//   top level, between step.run calls. Step tooling (sendEvent/run/sleep/...)
//   must NEVER be invoked from inside a step.run callback: the Inngest TS SDK
//   forbids nesting, and in production the nested call does not throw — the
//   request hangs for minutes and the run completes having sent NOTHING. That
//   exact bug shipped once here (a single 'sweep-page-batch' step wrapping the
//   whole loop, sendEvent nested inside it) and silently emitted zero push
//   events. src/test/inngest-step-mock.ts now fails any test that nests.
//
//   Replay determinism: the cursor advances purely from memoized step.run
//   results (the tail row of each page), so a re-invocation replays the same
//   page sequence and the same memoized sendEvent ids. Keep it that way — no
//   Date.now(), randomness, or out-of-band state in the cursor logic.
// =====================================================================

interface PushSweepEventData {
  workspaceId: string
  // Keyset cursor carried across self-chained continuations. Absent on the first
  // invocation; set to the last row of the previous page thereafter.
  cursorCreatedAt?: string
  cursorId?: string
  // Retry mode: when true, contacts carrying a persisted push-failure marker
  // (metadata.hubspot_push_error) are swept too. Default false — routine (cron)
  // sweeps skip them so a permanently-failing contact costs one Inngest run
  // total, not one per tick.
  includeFailed?: boolean
}

// How many pages of 100 a single invocation sweeps before self-chaining. Keeps
// each invocation bounded for large workspaces (mirrors hubspotInitialImport's
// MAX_PAGES_PER_RUN).
const MAX_PAGES_PER_RUN = 20
const PAGE_SIZE = 100

export const hubspotPushSweep = inngest.createFunction(
  {
    id: 'hubspot-push-sweep',
    retries: 2,
    // Debounce coalesces bursts (e.g. the settings PATCH and the next cron tick
    // firing within seconds of each other) into one run per workspace.
    debounce: { key: 'event.data.workspaceId', period: '60s' },
    // Per-workspace serialization: at most one sweep per workspace at a time so a
    // slow self-chaining sweep can't overlap the next invocation for the same
    // workspace and double-emit the same page. Different workspaces stay
    // parallel. Note: debounce only coalesces bursts across the debounce window;
    // the self-chained continuation fires AFTER the window, so concurrency (not
    // debounce) is what serializes a run against its own continuation.
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }],
    triggers: [{ event: 'crm/hubspot-push-sweep' }],
  },
  async ({ event, step }) => {
    const { workspaceId, cursorCreatedAt, cursorId, includeFailed } =
      event.data as PushSweepEventData
    const retryFailed = includeFailed === true
    const supabase = getServiceClient()

    // Step 1: guard — master toggle ON + HubSpot actually connected. Either
    // absent → clean no-op (the sweep is fired best-effort from several places).
    const guard = await step.run('load-guard', async () => {
      const { data: workspace } = await supabase
        .from('workspace')
        .select('settings')
        .eq('id', workspaceId)
        .maybeSingle()
      const settings = (workspace?.settings ?? {}) as Record<string, unknown>
      if (settings.push_contacts_to_hubspot !== true) {
        return { ok: false as const, reason: 'flag_off' }
      }
      const scope = settings.push_contacts_scope === 'all' ? 'all' : 'manual'

      const { data: syncState } = await supabase
        .from('crm_sync_state')
        .select('account_id')
        .eq('workspace_id', workspaceId)
        .eq('provider', HUBSPOT_SOURCE_PROVIDER)
        .limit(1)
        .maybeSingle()
      if (!syncState) {
        return { ok: false as const, reason: 'no_hubspot_account' }
      }

      return { ok: true as const, scope }
    })

    if (!guard.ok) {
      return { status: 'skipped' as const, reason: guard.reason }
    }

    // Step 2..N+1: page eligible contacts and fan out a push event per contact.
    // One step.run per page (query only) + one top-level step.sendEvent per page
    // (fan-out). See STEP STRUCTURE above for why the loop cannot live inside a
    // single step.run.
    //
    // The cursor moves in memory across iterations but is derived only from
    // memoized step.run output, so replays reproduce the identical page walk.
    let cursor: { createdAt: string; id: string } | null =
      cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : null
    let emitted = 0
    // Set when the table is exhausted (empty or short page). Falling out of the
    // loop with this still false means we hit the per-run page bound with rows
    // (potentially) remaining → self-chain.
    let drained = false

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      // Snapshot the cursor for this page so the step callback closes over an
      // immutable value rather than the mutable loop variable.
      const after = cursor

      // Eligibility mirrors the per-contact fn's gates that can be expressed as
      // a query: workspace match, not yet provider-linked (source_provider IS
      // NULL — also what makes re-sweeps skip already-pushed rows), not a merge
      // tombstone, has an email (the dedupe/create key), no permanent-failure
      // marker (unless this is an explicit retry sweep), and the scope filter.
      // Ordered by (created_at, id) for a stable keyset cursor.
      const rows = await step.run(`sweep-page-${page}`, async () => {
        let query = supabase
          .from('contact')
          .select('id, created_at')
          .eq('workspace_id', workspaceId)
          .is('source_provider', null)
          .is('merged_into_contact_id', null)
          .not('email', 'is', null)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(PAGE_SIZE)

        // Scope filter: 'manual' → only source='manual'; 'all' → any source
        // except 'member' (teammate self-contacts never leave the workspace).
        if (guard.scope === 'manual') {
          query = query.eq('source', 'manual')
        } else {
          query = query.neq('source', 'member')
        }

        // Permanent-failure filter. `metadata->hubspot_push_error is null` is
        // true for rows without the key at all (a missing jsonb key yields SQL
        // NULL), so unmarked contacts — the overwhelming majority — pass. Only
        // an explicit retry sweep drops the filter and re-admits marked rows.
        if (!retryFailed) {
          query = query.is(`metadata->${HUBSPOT_PUSH_ERROR_KEY}`, null)
        }
        // HOLD filter (Sequence step 2, plan A.1): a contact an unattended run
        // created waits for a person's edit — never swept, retry or not.
        query = query.is(`metadata->${HUBSPOT_PUSH_HOLD_KEY}`, null)

        // Keyset: rows strictly after the cursor in (created_at, id) order —
        // either a later created_at, or the same created_at with a larger id.
        if (after) {
          query = query.or(
            `created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`,
          )
        }

        const { data, error } = await query
        if (error) throw error

        return (data ?? []) as Array<{ id: string; created_at: string }>
      })

      // Nothing left on this page → drained. Break WITHOUT a sendEvent: an
      // empty batch is a pointless step + round-trip.
      if (rows.length === 0) {
        drained = true
        break
      }

      // Fan out one push event per contact. TOP LEVEL, never inside step.run.
      // The per-contact fn owns all gating + dedupe + the CAS link; the sweep
      // just pokes the rows.
      await step.sendEvent(
        `push-batch-${page}`,
        rows.map((row) => ({
          name: 'crm/hubspot-push-contact' as const,
          data: { contactId: row.id, workspaceId },
        })),
      )
      emitted += rows.length

      // Advance the keyset cursor to this page's tail row.
      const tail = rows[rows.length - 1]
      cursor = { createdAt: tail.created_at, id: tail.id }

      // A short page means we drained the table.
      if (rows.length < PAGE_SIZE) {
        drained = true
        break
      }
    }

    if (!drained && cursor) {
      // Self-chain from the last row of this run's final page (bounded
      // invocation), mirroring hubspotInitialImport.
      await step.sendEvent('continue-sweep', {
        name: 'crm/hubspot-push-sweep',
        data: {
          workspaceId,
          cursorCreatedAt: cursor.createdAt,
          cursorId: cursor.id,
          // Carry the retry mode forward — a retry sweep that self-chains must
          // stay a retry sweep, or every page past the first silently reverts
          // to skipping the marked contacts it was fired to re-attempt.
          includeFailed: retryFailed,
        },
      })
      return { status: 'continued' as const, emitted }
    }

    return { status: 'complete' as const, emitted }
  },
)
