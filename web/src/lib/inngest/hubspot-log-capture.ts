import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  createMeeting,
  HubspotUnauthorizedError,
} from '@/lib/integrations/hubspot-api'
import { HUBSPOT_SOURCE_PROVIDER } from '@/lib/crm/hubspot-sync'
import { logsMeetingsToHubspot } from '@/lib/crm/hubspot-meeting-log'

// =====================================================================
// HubSpot meeting-logging writeback (Phase 2)
//
// After a capture finishes processing, log it to HubSpot as ONE meeting
// engagement associated to every participant contact that carries a HubSpot
// object id. Fireflies model: summary + confirmed action items + a deep link
// back to the Native Intelligence capture, never the raw transcript.
//
// Triggered by crm/hubspot-log-capture, sent unconditionally from capture-
// ingest.ts alongside the extraction send. ALL gating lives here so the sender
// stays dumb:
//   0. capture visibility — a PRIVATE capture ("Only me") is never pushed to an
//      external CRM. This is the hardest boundary of them all: the summary would
//      leave the product entirely, into a system Native Intelligence visibility cannot reach
//      or revoke. Read fail-closed from the row here (NOT from the event's
//      flow_eligible flag, which the triage reconciler's re-fire omits), same
//      posture as flowDispatchOnCaptureProcessed. See
//      docs/design-capture-visibility.md.
//   1. workspace flag (workspace.settings.log_meetings_to_hubspot) — ON by
//      default (absent = on, logsMeetingsToHubspot); an explicit false from the
//      integration page's toggle → no-op.
//   2. idempotency: captures.metadata.hubspot_meeting_id already set → no-op.
//   3. no connected HubSpot account for the workspace → no-op.
//   4. no valid token → no-op (never throw-forever; the cron/read-sync path owns
//      token health).
//   5. zero participant contacts with a HubSpot id → no-op (v1: no email-search
//      fallback).
//   6. 401 from HubSpot (a token minted before the contacts.write scope existed)
//      → no-op with a clear log, NOT a retry — re-firing can't grow a scope the
//      token never had; the user must reconnect (the card shows the banner).
// Any of these is a clean, logged return — never a throw — so a workspace that
// hasn't opted in / reconnected never accretes failing Inngest runs.
// =====================================================================

interface LogCaptureEventData {
  captureId: string
  workspaceId: string
  ownerUserId: string
}

/**
 * Body char ceiling. HubSpot caps meeting notes at 65,536 chars; the brief asks
 * for < 60k to leave headroom. We truncate the summary portion (not the link)
 * so the deep link always survives.
 */
const MAX_BODY_CHARS = 60_000

export const hubspotLogCapture = inngest.createFunction(
  {
    id: 'hubspot-log-capture',
    retries: 3,
    // Invocation-level dedup: two events for the same capture (e.g. a Reprocess
    // double-fire) collapse to a single run within Inngest's idempotency window,
    // so only one run ever reaches the createMeeting call. This is the first line
    // of defence against duplicate HubSpot meetings; the metadata guard below
    // still catches long-horizon reprocesses that fall outside the window.
    idempotency: 'event.data.captureId',
    // Two concurrency constraints (Inngest evaluates both):
    //  - per-workspace cap (limit 5) mirrors capture-ingest — bound the fan-out
    //    so a burst of finished captures in one workspace can't stampede HubSpot.
    //  - per-capture serialization (limit 1) closes the check-then-act race on
    //    the metadata.hubspot_meeting_id guard: two concurrent runs for the same
    //    captureId can't both pass the guard and create duplicate meetings.
    concurrency: [
      { limit: 5, key: 'event.data.workspaceId' },
      { limit: 1, key: 'event.data.captureId' },
    ],
    triggers: [{ event: 'crm/hubspot-log-capture' }],
  },
  async ({ event, step }) => {
    const { captureId, workspaceId } = event.data as LogCaptureEventData
    const supabase = getServiceClient()

    // Step 1: load capture + visibility gate + opt-in flag + idempotency guard
    // in one read.
    const guard = await step.run('load-capture', async () => {
      const { data: capture, error } = await supabase
        .from('captures')
        .select('id, title, ai_summary, started_at, ended_at, metadata, visibility')
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      // Fail closed on a read error too: without the row we cannot prove the
      // capture is workspace-visible, and the alternative is shipping a private
      // summary to an external CRM.
      if (error || !capture) return { ok: false as const, reason: 'missing_capture' }

      // A private capture never leaves the product. Independent re-read rather
      // than trusting the event, which the triage reconciler emits unflagged.
      if ((capture.visibility as string | null) === 'private') {
        return { ok: false as const, reason: 'private_capture' }
      }

      const metadata = (capture.metadata ?? {}) as Record<string, unknown>
      // Idempotency: a prior run already created the engagement.
      if (metadata.hubspot_meeting_id) {
        return { ok: false as const, reason: 'already_logged' }
      }

      const { data: workspace } = await supabase
        .from('workspace')
        .select('settings')
        .eq('id', workspaceId)
        .maybeSingle()
      const settings = (workspace?.settings ?? {}) as Record<string, unknown>
      if (!logsMeetingsToHubspot(settings)) {
        return { ok: false as const, reason: 'flag_off' }
      }

      return {
        ok: true as const,
        title: (capture.title as string | null) ?? 'Meeting',
        summary: (capture.ai_summary as string | null) ?? '',
        startedAt: (capture.started_at as string | null) ?? null,
        endedAt: (capture.ended_at as string | null) ?? null,
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

    // Step 3: resolve participant contacts → HubSpot object ids. A capture with
    // no participant carrying a HubSpot id is a clean no-op (nothing to log to).
    const contactIds = await step.run('resolve-contacts', async () => {
      const { data: participants } = await supabase
        .from('capture_participant')
        .select('contact_id')
        .eq('capture_id', captureId)
      const localIds = Array.from(
        new Set(
          (participants ?? [])
            .map((p) => p.contact_id as string | null)
            .filter((id): id is string => !!id),
        ),
      )
      if (localIds.length === 0) return []

      const { data: contacts } = await supabase
        .from('contact')
        .select('provider_contact_id')
        .eq('workspace_id', workspaceId)
        .eq('source_provider', HUBSPOT_SOURCE_PROVIDER)
        .in('id', localIds)
      return Array.from(
        new Set(
          (contacts ?? [])
            .map((c) => c.provider_contact_id as string | null)
            .filter((id): id is string => !!id),
        ),
      )
    })

    if (contactIds.length === 0) {
      return { status: 'skipped' as const, reason: 'no_hubspot_contacts' }
    }

    // Step 4: token. Null → clean no-op (token health owned elsewhere).
    const tokenResult = await step.run('resolve-token', async () => {
      const result = await getValidTokenForAccount(accountId)
      return result ? { token: result.token } : null
    })
    if (!tokenResult) {
      return { status: 'skipped' as const, reason: 'no_token' }
    }

    // Step 5: create the meeting. A 401 here means the token predates the
    // contacts.write scope — no-op (the user reconnects), never retry-forever.
    const created = await step.run('create-meeting', async () => {
      const startMs = guard.startedAt ? Date.parse(guard.startedAt) : NaN
      const endMs = guard.endedAt ? Date.parse(guard.endedAt) : NaN
      // hs_timestamp is required; fall back to now when the capture has no start.
      const timestamp = Number.isNaN(startMs) ? Date.now() : startMs

      const body = await buildMeetingBody(supabase, {
        workspaceId,
        captureId,
        summary: guard.summary,
      })

      try {
        const meeting = await createMeeting(tokenResult.token, {
          hs_timestamp: String(timestamp),
          hs_meeting_title: guard.title,
          hs_meeting_body: body,
          ...(Number.isNaN(startMs) ? {} : { hs_meeting_start_time: String(startMs) }),
          ...(Number.isNaN(endMs) ? {} : { hs_meeting_end_time: String(endMs) }),
          contactIds,
        })
        return { ok: true as const, meetingId: meeting.id }
      } catch (err) {
        if (err instanceof HubspotUnauthorizedError) {
          console.warn(
            `[hubspot-log-capture] 401 creating meeting for capture ${captureId} ` +
              `(account ${accountId}) — token likely predates crm.objects.contacts.write. ` +
              'Skipping; user must reconnect HubSpot to enable meeting logging.',
          )
          return { ok: false as const, reason: 'unauthorized' as const }
        }
        throw err
      }
    })

    if (!created.ok) {
      return { status: 'skipped' as const, reason: created.reason }
    }

    // Step 6: persist the engagement id on the capture metadata (idempotency).
    // Read-modify-write the jsonb so we merge our key and never clobber others.
    await step.run('persist-meeting-id', async () => {
      const { data: row } = await supabase
        .from('captures')
        .select('metadata')
        .eq('id', captureId)
        .maybeSingle()
      const metadata = (row?.metadata ?? {}) as Record<string, unknown>
      await supabase
        .from('captures')
        .update({
          metadata: { ...metadata, hubspot_meeting_id: created.meetingId },
        })
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)
    })

    return {
      status: 'logged' as const,
      captureId,
      meetingId: created.meetingId,
      contactCount: contactIds.length,
    }
  },
)

/**
 * Assemble the plain-text meeting body: AI summary, a bulleted list of CONFIRMED
 * action items (suggested/dismissed excluded), and a link back to the Native Intelligence
 * capture. Truncates the summary (never the link) to stay under MAX_BODY_CHARS.
 */
async function buildMeetingBody(
  supabase: ReturnType<typeof getServiceClient>,
  opts: { workspaceId: string; captureId: string; summary: string },
): Promise<string> {
  const { data: actions } = await supabase
    .from('actions')
    .select('title')
    .eq('source_capture_id', opts.captureId)
    .eq('workspace_id', opts.workspaceId)
    .eq('confirmation', 'confirmed')

  const actionTitles = (actions ?? [])
    .map((a) => (a.title as string | null)?.trim())
    .filter((t): t is string => !!t)

  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://dial8.ai'
  const link = `${base}/account/captures/${opts.captureId}`

  // Build the fixed tail (action items + link) first so we know how much room is
  // left for the summary — the link must always survive truncation.
  const parts: string[] = []
  if (actionTitles.length > 0) {
    parts.push('Action items:')
    for (const t of actionTitles) parts.push(`- ${t}`)
  }
  parts.push(`View in Native Intelligence: ${link}`)
  const tail = '\n\n' + parts.join('\n')

  const summaryBudget = MAX_BODY_CHARS - tail.length
  let summary = opts.summary.trim()
  if (summaryBudget <= 0) {
    // Pathological: the tail alone exceeds the budget. Ship just the link tail.
    return tail.trimStart()
  }
  if (summary.length > summaryBudget) {
    let sliced = summary.slice(0, Math.max(0, summaryBudget - 1))
    // A blind slice can bisect an astral character (e.g. an emoji) at the
    // boundary, leaving a lone high surrogate. Drop a trailing unpaired high
    // surrogate (0xD800–0xDBFF) so the body stays well-formed UTF-16.
    const lastUnit = sliced.charCodeAt(sliced.length - 1)
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      sliced = sliced.slice(0, -1)
    }
    summary = sliced.trimEnd() + '…'
  }

  return (summary + tail).trim()
}
