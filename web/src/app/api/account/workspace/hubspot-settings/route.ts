import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { inngest } from '@/lib/inngest/client'
import { NextResponse, type NextRequest } from 'next/server'
import { logsMeetingsToHubspot } from '@/lib/crm/hubspot-meeting-log'

/**
 * GET/PATCH /api/account/workspace/hubspot-settings
 *
 * Reads/writes the per-workspace HubSpot writeback settings, all flat jsonb keys
 * on `workspace.settings`:
 *   - `log_meetings_to_hubspot` (boolean, default ON: absent = true; see
 *     logsMeetingsToHubspot, src/lib/crm/hubspot-meeting-log.ts) — when on,
 *     hubspot-log-capture logs each finished capture to HubSpot as a meeting
 *     engagement on every matched contact. Only an explicit false turns it off.
 *   - The contact push keys stay opt-in (absent = false / 'manual'):
 *   - `push_contacts_to_hubspot` (boolean) — the master on/off for contact push.
 *     When true, hubspot-push-contact mirrors eligible Native Intelligence contacts into
 *     HubSpot.
 *   - `push_contacts_scope` ('manual' | 'all', default 'manual') — which
 *     contacts push when the master toggle is on. 'manual' = only contacts the
 *     user created by hand (source='manual'); 'all' = any source except
 *     'member' (teammate self-contacts never leave the workspace). HubSpot
 *     marketing tiers bill per contact, so 'all' must be an explicit choice.
 *
 * Any member may READ the effective flags;
 * only owner/admin may WRITE (they change automated writeback behavior for the
 * whole workspace). The write read-modify-writes the settings jsonb so only the
 * key(s) present in the request are touched and no sibling settings are
 * clobbered. PATCH accepts any key independently (or several).
 *
 * Retroactive sweep: enabling contact push (or widening its scope 'manual'→'all'
 * while it's on) should mirror the contacts that already exist, not just future
 * ones. So the PATCH fires a best-effort `crm/hubspot-push-sweep` on exactly
 * those two transitions (never on a narrowing, a disable, or a no-op write),
 * with `includeFailed: true` so contacts whose push permanently failed earlier
 * (401 — token predated the write scope) get one more attempt. The sweep fn
 * self-guards (toggle off / no HubSpot account → no-op), so a spurious fire is
 * harmless; the fire is fully decoupled from the response (never fails the
 * PATCH).
 */

const VALID_SCOPES = ['manual', 'all'] as const
type PushContactsScope = (typeof VALID_SCOPES)[number]

function readScope(settings: Record<string, unknown>): PushContactsScope {
  return settings.push_contacts_scope === 'all' ? 'all' : 'manual'
}

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('workspace')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle()
  if (error) return serverError(error.message)

  const settings = (data?.settings ?? {}) as Record<string, unknown>
  return NextResponse.json({
    log_meetings_to_hubspot: logsMeetingsToHubspot(settings),
    push_contacts_to_hubspot: settings.push_contacts_to_hubspot === true,
    push_contacts_scope: readScope(settings),
  })
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  // Toggling writeback is an admin/owner action — it changes what leaves the
  // workspace and lands in the connected HubSpot portal for everyone.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change HubSpot writeback settings')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const payload = (body ?? {}) as {
    log_meetings_to_hubspot?: unknown
    push_contacts_to_hubspot?: unknown
    push_contacts_scope?: unknown
  }

  // Validate whichever key(s) are present; at least one must be supplied.
  const patch: Record<string, unknown> = {}
  if (payload.log_meetings_to_hubspot !== undefined) {
    if (typeof payload.log_meetings_to_hubspot !== 'boolean') {
      return badRequest('`log_meetings_to_hubspot` must be a boolean')
    }
    patch.log_meetings_to_hubspot = payload.log_meetings_to_hubspot
  }
  if (payload.push_contacts_to_hubspot !== undefined) {
    if (typeof payload.push_contacts_to_hubspot !== 'boolean') {
      return badRequest('`push_contacts_to_hubspot` must be a boolean')
    }
    patch.push_contacts_to_hubspot = payload.push_contacts_to_hubspot
  }
  if (payload.push_contacts_scope !== undefined) {
    if (
      typeof payload.push_contacts_scope !== 'string' ||
      !VALID_SCOPES.includes(payload.push_contacts_scope as PushContactsScope)
    ) {
      return badRequest("`push_contacts_scope` must be 'manual' or 'all'")
    }
    patch.push_contacts_scope = payload.push_contacts_scope
  }
  if (Object.keys(patch).length === 0) {
    return badRequest(
      'Expected `log_meetings_to_hubspot`, `push_contacts_to_hubspot`, ' +
        'and/or `push_contacts_scope`',
    )
  }

  // Read-modify-write the settings jsonb so we only touch the supplied key(s)
  // and leave any other settings keys — including the sibling HubSpot flag we
  // weren't asked to change — intact.
  const { data: current, error: readErr } = await supabase
    .from('workspace')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle()
  if (readErr) return serverError(readErr.message)

  const currentSettings = (current?.settings ?? {}) as Record<string, unknown>
  const settings = {
    ...currentSettings,
    ...patch,
  }

  // Snapshot the effective state before and after so we can detect the two
  // transitions that warrant a retroactive sweep. Compare AFTER the merge so a
  // no-op PATCH (writing the same values back) never fires.
  const wasPushOn = currentSettings.push_contacts_to_hubspot === true
  const isPushOn = settings.push_contacts_to_hubspot === true
  const prevScope = readScope(currentSettings)
  const nextScope = readScope(settings)

  // The role gate above IS the authorization boundary for this write. RLS on
  // `workspace` allows UPDATE to OWNERS only (migration 013, "Owners can update
  // workspace"), so an admin writing through the session client would update 0
  // rows and — a 0-row update reporting no error — get a 200 echoing back flags
  // that were never stored. Worse here than elsewhere: the sweep below would
  // then fire a real crm/hubspot-push-sweep off a transition that never
  // happened. The service client is therefore deliberate, used only AFTER the
  // owner/admin check has passed; the READ above stays on the RLS-scoped
  // session client.
  //
  // `.select('id')` asserts the write's EFFECT: 0 rows is a failure, not a
  // silent success, so any future policy/route mismatch fails loudly — and the
  // sweep stays downstream of a write that actually landed.
  const service = (await import('@/lib/supabase/service')).getServiceClient()
  const { data: updated, error: writeErr } = await service
    .from('workspace')
    .update({ settings })
    .eq('id', workspaceId)
    .select('id')
  if (writeErr) return serverError(writeErr.message)
  if (!updated || updated.length === 0) {
    return serverError('Workspace HubSpot settings update affected no rows')
  }

  // Fire the retroactive sweep on exactly two transitions:
  //   (a) the master toggle just turned ON (false → true), OR
  //   (b) the scope just widened 'manual' → 'all' while the toggle stays on.
  // Never on a narrowing, a disable, or a no-op. The sweep fn re-checks the
  // toggle + HubSpot account, so a fire that races a concurrent disable is a
  // clean no-op. Best-effort: decoupled from the response — a send failure must
  // never fail the settings write the user already succeeded at.
  //
  // includeFailed: true — this is the ONE trigger that retries contacts whose
  // push permanently failed (401 → metadata.hubspot_push_error, which the
  // routine cron sweep skips forever). Turning push on / widening it is
  // typically the step right after reconnecting HubSpot with the write scope,
  // i.e. exactly when those rows deserve another attempt.
  const toggledOn = isPushOn && !wasPushOn
  const scopeWidened = isPushOn && wasPushOn && prevScope === 'manual' && nextScope === 'all'
  if (toggledOn || scopeWidened) {
    inngest
      .send({ name: 'crm/hubspot-push-sweep', data: { workspaceId, includeFailed: true } })
      .catch((err) => {
        console.error('[hubspot-settings] hubspot-push-sweep send failed', err)
      })
  }

  return NextResponse.json({
    log_meetings_to_hubspot: logsMeetingsToHubspot(settings),
    push_contacts_to_hubspot: settings.push_contacts_to_hubspot === true,
    push_contacts_scope: nextScope,
  })
}
