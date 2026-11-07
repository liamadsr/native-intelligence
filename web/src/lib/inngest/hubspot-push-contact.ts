import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  archiveContact,
  createContact,
  searchContactByEmail,
  HubspotApiError,
  HubspotUnauthorizedError,
} from '@/lib/integrations/hubspot-api'
import { HUBSPOT_PUSH_ERROR_KEY, HUBSPOT_SOURCE_PROVIDER } from '@/lib/crm/hubspot-sync'
import { hasHubspotPushHold } from '@/lib/crm/hubspot-push-hold'

// =====================================================================
// HubSpot contact-push writeback (Phase 2 — sibling of hubspot-log-capture)
//
// When a contact becomes eligible in Dial8, mirror it into the connected
// HubSpot portal (dedupe-by-email first). Triggered by crm/hubspot-push-contact,
// sent fire-and-forget from the manual-creation surfaces (POST
// /api/account/contacts, the create_contact AI tool) and fanned out by the
// retroactive sweep (hubspot-push-sweep). ALL gating lives here so the senders
// stay dumb — they only need the contact to carry an email:
//   1. workspace opt-in flag (workspace.settings.push_contacts_to_hubspot) — the
//      default-absent-false master toggle. Falsy → no-op.
//   2. the contact must still be eligible to push under the workspace's SCOPE
//      (workspace.settings.push_contacts_scope, default 'manual'):
//        - scope 'manual' → source === 'manual' only (the deliberate,
//          hand-created contacts). This is the conservative default.
//        - scope 'all'    → any source EXCEPT 'member' (teammate self-contacts
//          never leave the workspace). HubSpot marketing tiers bill per contact,
//          so 'all' is an explicit, per-workspace choice.
//      Regardless of scope it must additionally be: not a merge tombstone
//      (merged_into_contact_id), not already linked to a provider
//      (source_provider set — already pushed or imported from HubSpot), and it
//      must carry an email (the dedupe + create key). The source_provider IS
//      NULL guard is also what keeps a re-sweep from re-pushing rows the read-
//      sync or a prior push already claimed.
//   3. no connected HubSpot account for the workspace → no-op.
//   4. no valid token → no-op (token health owned by the read-sync/cron path).
//   5. dedupe: SEARCH HubSpot for the email first. Found → claim the local row
//      (source_provider='hubspot', provider_contact_id=<id>) and stop, never
//      creating a duplicate. This is the primary defence against duplicates.
//   6. else CREATE the contact, then persist provider_contact_id +
//      source_provider='hubspot' locally (source stays 'manual'). The persist is
//      a COMPARE-AND-SWAP guarded on source_provider IS NULL: the read-sync can
//      claim the same row during our multi-round-trip window, and an
//      unconditional write would clobber that claim + orphan the object we just
//      created. On a lost swap we best-effort archive a JUST-CREATED HubSpot
//      contact (a search-claim keeps the existing object) and return a logged
//      'lost_claim_race' no-op.
//   7. 409 from HubSpot (email exists — a create-race against a concurrent
//      writer) → re-search once and claim the now-visible object.
//   8. 401 from HubSpot (token predates the contacts.write scope) → clean no-op,
//      NOT a retry (re-firing can't grow a scope the token never had; the user
//      reconnects). Any other error rethrows so Inngest retries.
// Every gate is a clean, logged return — never a throw — so a workspace that
// hasn't opted in / reconnected never accretes failing Inngest runs.
//
// PERMANENT-FAILURE MARKER (the 401 path, gate 8): such a contact never gets
// source_provider set, so it stays eligible for every future sweep and would be
// re-pushed — and re-401'd — on every cron tick, forever, with nothing but a log
// line to show for it. So the 401 path PERSISTS a marker at
// `contact.metadata.hubspot_push_error` = { code: 'unauthorized', at: <ISO> }
// (read-modify-write, sibling metadata keys preserved). The sweep excludes marked
// contacts from its routine fires and re-admits them only on an explicit retry
// (includeFailed, sent by the settings PATCH after a reconnect / scope change).
// Any successful push or claim CLEARS the marker.
//
// HOLD MARKER (Sequence step 2, plan A.1): a contact an UNATTENDED run created
// (the create_contact tool on a work-run / skill-run) carries
// `contact.metadata.hubspot_push_hold` — see src/lib/crm/hubspot-push-hold.ts.
// Gate: a held contact is a clean 'held' no-op here, and the sweep never emits
// it. A person's edit (PATCH /api/account/contacts/[id]) lifts the hold.
// =====================================================================

interface PushContactEventData {
  contactId: string
  workspaceId: string
}

export const hubspotPushContact = inngest.createFunction(
  {
    id: 'hubspot-push-contact',
    retries: 3,
    // Invocation-level dedup: two events for the same contact (e.g. a
    // double-submit) collapse to a single run within Inngest's idempotency
    // window, so only one run ever reaches the create call. First line of
    // defence against duplicate HubSpot contacts; the email dedupe-search below
    // still catches long-horizon re-fires that fall outside the window.
    idempotency: 'event.data.contactId',
    // Two concurrency constraints (Inngest evaluates both):
    //  - per-workspace cap (limit 5) mirrors hubspot-log-capture — bound the
    //    fan-out so a burst of contact creations in one workspace can't stampede
    //    HubSpot's contacts API.
    //  - per-contact serialization (limit 1) closes the check-then-act race on
    //    the "already linked" guard + the search→create window: two concurrent
    //    runs for the same contactId can't both pass and create duplicates.
    concurrency: [
      { limit: 5, key: 'event.data.workspaceId' },
      { limit: 1, key: 'event.data.contactId' },
    ],
    triggers: [{ event: 'crm/hubspot-push-contact' }],
  },
  async ({ event, step }) => {
    const { contactId, workspaceId } = event.data as PushContactEventData
    const supabase = getServiceClient()

    // Step 1: load contact + opt-in flag + all eligibility gates in one read.
    const guard = await step.run('load-contact', async () => {
      const { data: workspace } = await supabase
        .from('workspace')
        .select('settings')
        .eq('id', workspaceId)
        .maybeSingle()
      const settings = (workspace?.settings ?? {}) as Record<string, unknown>
      if (settings.push_contacts_to_hubspot !== true) {
        return { ok: false as const, reason: 'flag_off' }
      }
      // Scope decides WHICH contacts are eligible (default 'manual').
      const scope = settings.push_contacts_scope === 'all' ? 'all' : 'manual'

      const { data: contact } = await supabase
        .from('contact')
        .select(
          'id, email, first_name, last_name, phone, job_title, source, source_provider, provider_contact_id, merged_into_contact_id, metadata',
        )
        .eq('id', contactId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (!contact) return { ok: false as const, reason: 'missing_contact' }

      // Scope gate — the critical guard on WHICH contacts may leave the
      // workspace. 'manual' admits only hand-created contacts; 'all' admits any
      // source except 'member' (teammate self-contacts are never pushed).
      if (scope === 'manual') {
        if (contact.source !== 'manual') {
          return { ok: false as const, reason: 'not_manual' }
        }
      } else {
        // scope === 'all'
        if (contact.source === 'member') {
          return { ok: false as const, reason: 'member_excluded' }
        }
      }
      if (contact.merged_into_contact_id) {
        return { ok: false as const, reason: 'merged' }
      }
      // Already linked to a provider (pushed before, or imported FROM HubSpot).
      if (contact.source_provider) {
        return { ok: false as const, reason: 'already_linked' }
      }
      // HELD (Sequence step 2, plan A.1): created by an unattended run; not
      // pushed until a person edits it (the contacts PATCH route lifts the hold
      // and sends this event again).
      if (hasHubspotPushHold(contact.metadata)) {
        return { ok: false as const, reason: 'held' }
      }
      const email = (contact.email as string | null)?.trim()
      if (!email) {
        return { ok: false as const, reason: 'no_email' }
      }

      return {
        ok: true as const,
        email,
        firstname: (contact.first_name as string | null) ?? null,
        lastname: (contact.last_name as string | null) ?? null,
        phone: (contact.phone as string | null) ?? null,
        jobtitle: (contact.job_title as string | null) ?? null,
      }
    })

    if (!guard.ok) {
      return { status: 'skipped' as const, reason: guard.reason }
    }

    // Step 2: resolve the workspace's HubSpot connected account. crm_sync_state
    // is the canonical workspace→account map (one row per connected account,
    // seeded at OAuth callback). No row → the workspace has no HubSpot.
    const accountId = await step.run('resolve-account', async () => {
      const { data } = await supabase
        .from('crm_sync_state')
        .select('account_id')
        .eq('workspace_id', workspaceId)
        .eq('provider', HUBSPOT_SOURCE_PROVIDER)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      return (data?.account_id as string | undefined) ?? null
    })

    if (!accountId) {
      return { status: 'skipped' as const, reason: 'no_hubspot_account' }
    }

    // Step 3: token. Null → clean no-op (token health owned elsewhere).
    const tokenResult = await step.run('resolve-token', async () => {
      const result = await getValidTokenForAccount(accountId)
      return result ? { token: result.token } : null
    })
    if (!tokenResult) {
      return { status: 'skipped' as const, reason: 'no_token' }
    }

    // Step 4: dedupe-search + create. A 401 anywhere here means the token
    // predates the contacts.write scope — no-op (the user reconnects), never
    // retry-forever. A found match (search hit, or a 409 create-race) claims the
    // existing object instead of creating a duplicate.
    const result = await step.run('push-contact', async () => {
      const token = tokenResult.token

      try {
        // Dedupe first: if HubSpot already has this email, claim it.
        const existing = await searchContactByEmail(token, guard.email)
        if (existing) {
          return { ok: true as const, action: 'claimed' as const, hubspotId: existing.id }
        }

        // Otherwise create it.
        try {
          const created = await createContact(token, {
            email: guard.email,
            firstname: guard.firstname,
            lastname: guard.lastname,
            phone: guard.phone,
            jobtitle: guard.jobtitle,
          })
          return { ok: true as const, action: 'created' as const, hubspotId: created.id }
        } catch (err) {
          // 409: the email was created by a concurrent writer between our search
          // and our create. Re-search once and claim the now-visible object.
          if (err instanceof HubspotApiError && err.status === 409) {
            const raced = await searchContactByEmail(token, guard.email)
            if (raced) {
              return { ok: true as const, action: 'claimed' as const, hubspotId: raced.id }
            }
            // Search still empty after a 409 — pathological; rethrow to retry.
            throw err
          }
          throw err
        }
      } catch (err) {
        if (err instanceof HubspotUnauthorizedError) {
          console.warn(
            `[hubspot-push-contact] 401 pushing contact ${contactId} ` +
              `(account ${accountId}) — token likely predates crm.objects.contacts.write. ` +
              'Skipping; user must reconnect HubSpot to enable contact push.',
          )
          return { ok: false as const, reason: 'unauthorized' as const }
        }
        throw err
      }
    })

    if (!result.ok) {
      // Persist the permanent-failure marker so the sweep stops re-emitting this
      // contact on every cron tick. Read-modify-write the metadata jsonb: we own
      // exactly one key and must never clobber a sibling (voice ids, import
      // provenance, …). Best-effort — a marker write failure must not turn a
      // clean no-op into a retrying run, so it's swallowed and logged.
      await step.run('mark-push-failure', async () => {
        const { data: row, error: readErr } = await supabase
          .from('contact')
          .select('metadata')
          .eq('id', contactId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        if (readErr) {
          console.error(
            `[hubspot-push-contact] failed to read metadata for contact ${contactId}:`,
            readErr,
          )
          return null
        }
        const metadata = (row?.metadata ?? {}) as Record<string, unknown>
        const { error: writeErr } = await supabase
          .from('contact')
          .update({
            metadata: {
              ...metadata,
              [HUBSPOT_PUSH_ERROR_KEY]: {
                code: result.reason,
                at: new Date().toISOString(),
              },
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', contactId)
          .eq('workspace_id', workspaceId)
        if (writeErr) {
          console.error(
            `[hubspot-push-contact] failed to persist push-failure marker for ` +
              `contact ${contactId}:`,
            writeErr,
          )
        }
        return null
      })
      return { status: 'skipped' as const, reason: result.reason }
    }

    // Step 5: claim the local row with a COMPARE-AND-SWAP. The window between our
    // eligibility read (step 1) and here spans several HubSpot round-trips, and
    // the read-sync (upsertHubspotContact's email-match branch) can claim this
    // very row concurrently. An unconditional update would clobber that claim,
    // desyncing the row and orphaning whatever object we just created. So we only
    // write when source_provider IS STILL NULL, and ask for the row back to learn
    // whether the swap landed. Keep source='manual' — this contact was, and
    // remains, a human-created row; source_provider records where it now lives.
    const persisted = await step.run('persist-provider-id', async () => {
      const patch: Record<string, unknown> = {
        source_provider: HUBSPOT_SOURCE_PROVIDER,
        provider_contact_id: result.hubspotId,
        updated_at: new Date().toISOString(),
      }

      // A push that succeeds retires any earlier permanent-failure marker (the
      // user reconnected with the write scope). Read-modify-write so siblings
      // survive, and only touch metadata when a marker is actually there — an
      // unconditional metadata write would needlessly race other writers.
      const { data: current } = await supabase
        .from('contact')
        .select('metadata')
        .eq('id', contactId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      const metadata = (current?.metadata ?? {}) as Record<string, unknown>
      if (HUBSPOT_PUSH_ERROR_KEY in metadata) {
        const cleared = { ...metadata }
        delete cleared[HUBSPOT_PUSH_ERROR_KEY]
        patch.metadata = cleared
      }

      const { data, error } = await supabase
        .from('contact')
        .update(patch)
        .eq('id', contactId)
        .eq('workspace_id', workspaceId)
        .is('source_provider', null)
        .select('id')
      // A real DB error must retry (Inngest) — don't mistake it for a lost race.
      if (error) throw error
      // Zero rows back → the CAS matched nothing: another writer set
      // source_provider first. We lost the claim race.
      return { won: (data?.length ?? 0) > 0 }
    })

    if (!persisted.won) {
      // Lost the race. If THIS run created a brand-new HubSpot object, it is now
      // orphaned (the winning writer linked the local row to a different id, or
      // to the same one it discovered independently). Best-effort archive it so
      // we don't leave a duplicate. A search-CLAIM keeps the existing object —
      // nothing to undo. Never throw here: this is a no-op resolution path.
      if (result.action === 'created') {
        await step.run('archive-orphan-contact', async () => {
          await archiveContact(tokenResult.token, result.hubspotId)
          return null
        })
      }
      console.warn(
        `[hubspot-push-contact] lost claim race for contact ${contactId} ` +
          `(hubspot ${result.hubspotId}, action=${result.action}) — another writer ` +
          'claimed the local row first' +
          (result.action === 'created' ? '; archived the orphaned HubSpot contact.' : '.'),
      )
      return {
        status: 'lost_claim_race' as const,
        contactId,
        hubspotId: result.hubspotId,
      }
    }

    return {
      status: result.action === 'claimed' ? ('claimed' as const) : ('created' as const),
      contactId,
      hubspotId: result.hubspotId,
    }
  },
)
