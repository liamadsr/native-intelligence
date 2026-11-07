import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncCalendarToCaptures, getUpcomingCaptures } from '@/lib/integrations/calendar-sync'
import { listCalendarEvents, getCalendarProvider } from '@/lib/integrations/calendar'
import { deriveSeriesIdentity } from '@/lib/integrations/meeting-series'
import { applyEmbeddedCaptureVisibility, captureRequester, isCaptureVisible } from './_shared'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { findMembersByEmail } from '@/lib/workspace-member-emails'
import { findMeetingGoalForCapture, findUpcomingMeetingGoalForEvent, getMeetingGoal } from '@/lib/meetings/meeting-goal'

/**
 * draft_followup_email interpolates capture_id into a same-origin URL and sends
 * the caller's bearer with it. A model-supplied id like `../../x/route?y=` is
 * normalised by the URL parser, so without this check a prompt-injected id
 * steers the caller's JWT to any same-origin POST route. Only a bare UUID may
 * reach the path, and it is encoded besides.
 */
const CAPTURE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DRAFT_FOLLOWUP_PATH = /^\/api\/account\/captures\/[0-9a-f-]{36}\/draft-followup$/i
/** get_meeting_prep with an event id and no start: the goal (and the anchor capture) of an occurrence that started at most this long ago. */
const PREP_GOAL_LOOKBACK_MS = 12 * 60 * 60_000

export function createCalendarCaptureTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  accessToken?: string,
  omitPrivateCaptures = false,
) {
  const requester = captureRequester(userId, omitPrivateCaptures)
  return {
    sync_calendar: tool({
      description:
        'Sync upcoming calendar events to captures. Creates pending captures for meetings with 2+ attendees. Run this when the user wants to see their upcoming meetings or prepare for them.',
      inputSchema: z.object({}),
      execute: async () => {
        const provider = await getCalendarProvider(userId)
        if (!provider) {
          return {
            success: false,
            error: 'No calendar connected. Offer the person a Connect card: call connect with provider "google" or "microsoft" and capability "calendar". Never ask for a password or token.',
          }
        }

        try {
          const result = await syncCalendarToCaptures(userId, workspaceId)
          return {
            success: true,
            synced: result.synced,
            total: result.total,
            message: result.synced > 0
              ? `Synced ${result.synced} new meeting(s) from calendar. ${result.total} total upcoming meetings.`
              : `Calendar up to date. ${result.total} upcoming meetings already synced.`,
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to sync calendar',
          }
        }
      },
    }),

    get_upcoming_meetings: tool({
      description:
        'Get the next upcoming meetings with their capture status (pending, ready, recording, completed). Use when the user asks "what meetings do I have today?" or "am I prepared for my next meeting?"',
      inputSchema: z.object({
        hours_ahead: z
          .number()
          .optional()
          .default(24)
          .describe('How many hours ahead to look (default: 24)'),
      }),
      execute: async ({ hours_ahead }) => {
        try {
          const captures = await getUpcomingCaptures(userId, workspaceId, hours_ahead)

          if (!captures.length) {
            // Also check calendar directly for events without captures
            const provider = await getCalendarProvider(userId)
            if (!provider) {
              return {
                success: true,
                meetings: [],
                message: 'No calendar connected.',
              }
            }

            const now = new Date()
            const cutoff = new Date(now.getTime() + hours_ahead * 60 * 60 * 1000)
            const events = await listCalendarEvents(userId, {
              timeMin: now.toISOString(),
              timeMax: cutoff.toISOString(),
              maxResults: 10,
            })

            return {
              success: true,
              meetings: events.map((e) => ({
                title: e.title,
                start: e.start,
                end: e.end,
                attendees: e.attendees,
                conference_url: e.conferenceUrl,
                capture_status: null,
              })),
              message: events.length
                ? `${events.length} meeting(s) in the next ${hours_ahead} hours. Run sync_calendar to create captures for them.`
                : 'No meetings coming up.',
            }
          }

          return {
            success: true,
            meetings: captures,
            message: `${captures.length} meeting(s) in the next ${hours_ahead} hours.`,
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to fetch meetings',
          }
        }
      },
    }),

    create_capture_from_event: tool({
      description:
        'Create a capture from a specific calendar event. Use when the user says "create a capture for my 2pm meeting" or wants to retroactively capture a past meeting.',
      inputSchema: z.object({
        event_id: z.string().describe('Calendar event ID'),
        title: z.string().optional().describe('Override title (uses event title if not provided)'),
      }),
      execute: async ({ event_id, title }) => {
        // A live (un-ended) capture of the caller's for this event id — ended
        // captures are the recurring meeting's history (EventKit occurrences
        // share one event id), so they only block re-creating the SAME
        // occurrence, checked below once the event is resolved.
        const { data: existing } = await supabase
          .from('captures')
          .select('id, title')
          .eq('calendar_event_id', event_id)
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .neq('status', 'archived')
          .is('ended_at', null)
          .limit(1)
          .maybeSingle()

        if (existing) {
          return {
            success: true,
            capture: existing,
            message: `A capture already exists for this event: "${existing.title}"`,
            already_existed: true,
          }
        }

        // Get event details from calendar
        const provider = await getCalendarProvider(userId)
        if (!provider) {
          return { success: false, error: 'No calendar connected.' }
        }

        // Fetch the event. The provider returns one page in start order, so a
        // single wide window found nothing past its first page on a busy
        // calendar: look near today first (the usual case), then the wide
        // window, each with a page big enough for a full calendar.
        const now = new Date()
        const DAY_MS = 24 * 60 * 60 * 1000
        let event: Awaited<ReturnType<typeof listCalendarEvents>>[number] | undefined
        for (const [daysBack, daysAhead] of [[7, 30], [90, 90]]) {
          const events = await listCalendarEvents(userId, {
            timeMin: new Date(now.getTime() - daysBack * DAY_MS).toISOString(),
            timeMax: new Date(now.getTime() + daysAhead * DAY_MS).toISOString(),
            maxResults: 500,
          })
          event = events.find((e) => e.id === event_id)
          if (event) break
        }
        if (!event) {
          return { success: false, error: 'Calendar event not found.' }
        }

        const identity = deriveSeriesIdentity(event)

        if (identity.occurrenceStart) {
          const { data: captured } = await supabase
            .from('captures')
            .select('id, title')
            .eq('calendar_event_id', event_id)
            .eq('user_id', userId)
            .eq('workspace_id', workspaceId)
            .neq('status', 'archived')
            .eq('occurrence_start', identity.occurrenceStart)
            .limit(1)
            .maybeSingle()
          if (captured) {
            return {
              success: true,
              capture: captured,
              message: `A capture already exists for this occurrence: "${captured.title}"`,
              already_existed: true,
            }
          }
        }

        const { data: capture, error } = await supabase
          .from('captures')
          .insert({
            user_id: userId,
            workspace_id: workspaceId,
            title: title || event.title,
            calendar_event_id: event.id,
            calendar_provider: provider,
            scheduled_start: event.start,
            scheduled_end: event.end,
            meeting_url: event.conferenceUrl || event.location || null,
            organizer_email: event.organizer || null,
            auto_capture_status: new Date(event.end) < now ? 'completed' : 'pending',
            status: 'active',
            series_key: identity.seriesKey,
            ical_uid: identity.icalUid,
            occurrence_start: identity.occurrenceStart,
            // Retro captures are created already closed — a live transcript-less
            // row for a past occurrence would be re-stamped to the NEXT
            // occurrence by from-event's reuse rule and would suppress calendar
            // sync's pending row for shared EventKit event ids.
            ...(new Date(event.end) < now ? { ended_at: event.end } : {}),
          })
          .select('id, title')
          .single()

        if (error) return { success: false, error: error.message }

        return {
          success: true,
          capture,
          message: `Created capture: "${capture.title}"`,
          already_existed: false,
        }
      },
    }),

    draft_followup_email: tool({
      description:
        'Generate and save a follow-up email draft from a processed capture. Use when the user says "draft a follow-up for the standup" or "send the team a summary of our meeting." Only creates a draft — does NOT send.',
      inputSchema: z.object({
        capture_id: z.string().regex(CAPTURE_ID_RE, 'capture_id must be a UUID').describe('UUID of the capture'),
        recipients: z
          .array(z.string())
          .optional()
          .describe('Email addresses of recipients (defaults to capture participants)'),
        tone: z
          .enum(['formal', 'casual', 'brief', 'professional'])
          .optional()
          .default('professional')
          .describe('Email tone'),
        additional_context: z
          .string()
          .optional()
          .describe('Additional notes to include in the email'),
      }),
      execute: async ({ capture_id, recipients, tone, additional_context }) => {
        // Re-checked here: execute can be reached without the AI SDK's input
        // validation (tests, direct callers), and the bearer must never follow
        // a path the model shaped.
        if (typeof capture_id !== 'string' || !CAPTURE_ID_RE.test(capture_id)) {
          return { success: false, error: 'capture_id must be a capture UUID' }
        }
        const origin = process.env.NEXT_PUBLIC_APP_URL || ''
        const url = `${origin}/api/account/captures/${encodeURIComponent(capture_id)}/draft-followup`
        if (!DRAFT_FOLLOWUP_PATH.test(new URL(url, 'http://localhost').pathname)) {
          return { success: false, error: 'capture_id must be a capture UUID' }
        }
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          // The endpoint resolves its workspace with getCurrentWorkspaceId(),
          // which verifies membership for this header; without it a bearer
          // caller falls back to the OLDEST membership, not this run's tenancy.
          'x-workspace-id': workspaceId,
        }
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`
        }

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              recipients,
              tone,
              additional_context,
              include_actions: true,
              include_decisions: true,
            }),
          })

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Failed to draft email' }))
            return { success: false, error: err.error }
          }

          const data = await res.json()

          return {
            success: true,
            subject: data.subject,
            to: data.to,
            body: data.body,
            draft_saved: !!data.draft_id,
            provider: data.provider,
            message: data.draft_id
              ? `Follow-up email drafted and saved to ${data.provider === 'google' ? 'Gmail' : 'Outlook'} drafts.`
              : 'Follow-up email drafted. No email provider connected — the user can copy and send manually.',
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to draft email',
          }
        }
      },
    }),

    get_meeting_prep: tool({
      description:
        'Prepare for an upcoming meeting. Searches past captures, actions, decisions, and what the knowledge graph knows about the attendees (their commitments, facts, and open questions) related to the meeting\'s participants or topic. Use when the user asks to "prepare for" a meeting.',
      inputSchema: z.object({
        event_id: z
          .string()
          .optional()
          .describe('Calendar event ID (uses next upcoming event if not provided)'),
        participant_email: z
          .string()
          .optional()
          .describe('Specific participant email to focus on'),
        starts_at: z
          .string()
          .optional()
          .describe("The meeting's start (ISO 8601), with event_id: finds the goal set for that occurrence"),
      }),
      execute: async ({ event_id, participant_email, starts_at }) => {
        try {
          // 1. Get the event
          let eventTitle = ''
          let participantEmails: string[] = []
          // Series thread of the resolved meeting — when present, its prior
          // occurrences ARE the meeting's history and beat attendee-overlap.
          let seriesKey: string | null = null
          let seriesIcalUid: string | null = null
          let anchorCaptureId: string | null = null
          // The anchor is this event's upcoming (or just started) occurrence:
          // one id can stand for a whole series, and the goal is per occurrence.
          let anchorUpcoming = false

          if (event_id) {
            // Look up the capture for this event: its next occurrence first,
            // else any capture of it (a past meeting's prep still has history).
            const CAPTURE_COLS = 'id, title, calendar_event_id, series_key, ical_uid'
            const { data: upcoming } = await supabase
              .from('captures')
              .select(CAPTURE_COLS)
              .eq('calendar_event_id', event_id)
              .eq('workspace_id', workspaceId)
              .gte('scheduled_start', new Date(Date.now() - PREP_GOAL_LOOKBACK_MS).toISOString())
              .order('scheduled_start', { ascending: true })
              .limit(1)
              .maybeSingle()
            anchorUpcoming = !!upcoming
            const capture =
              upcoming ??
              (
                await supabase
                  .from('captures')
                  .select(CAPTURE_COLS)
                  .eq('calendar_event_id', event_id)
                  .eq('workspace_id', workspaceId)
                  .limit(1)
                  .maybeSingle()
              ).data

            if (capture) {
              eventTitle = capture.title
              seriesKey = capture.series_key || null
              seriesIcalUid = capture.ical_uid || null
              anchorCaptureId = capture.id
              // Get participants
              const { data: parts } = await supabase
                .from('capture_participant')
                .select('external_email')
                .eq('capture_id', capture.id)
              participantEmails = (parts || []).map((p) => p.external_email).filter(Boolean) as string[]
            }
          }

          if (participant_email) {
            participantEmails = [participant_email]
          }

          // If no event found, get the next upcoming capture
          if (!participantEmails.length && !event_id) {
            const { data: nextCapture } = await supabase
              .from('captures')
              .select('id, title, scheduled_start, series_key, ical_uid')
              .eq('workspace_id', workspaceId)
              .eq('user_id', userId)
              .eq('auto_capture_status', 'pending')
              .gte('scheduled_start', new Date().toISOString())
              .order('scheduled_start', { ascending: true })
              .limit(1)
              .maybeSingle()

            if (nextCapture) {
              eventTitle = nextCapture.title
              seriesKey = nextCapture.series_key || null
              seriesIcalUid = nextCapture.ical_uid || null
              anchorCaptureId = nextCapture.id
              const { data: parts } = await supabase
                .from('capture_participant')
                .select('external_email')
                .eq('capture_id', nextCapture.id)
              participantEmails = (parts || []).map((p) => p.external_email).filter(Boolean) as string[]
            }
          }

          // The goal the person set for this meeting (migration 356): the
          // occurrence named by event id and start; with no start, the event's
          // next occurrence's, else its upcoming capture's (never a past
          // occurrence of a series); with no event, the next capture's. Theirs
          // alone (the store fences on the person); best-effort, a failed read
          // is no goal.
          const goalLoad = (async (): Promise<string | null> => {
            try {
              const who = { workspaceId, userId }
              const goal = event_id
                ? starts_at
                  ? await getMeetingGoal(supabase, { ...who, calendarEventId: event_id, startsAt: starts_at })
                  : ((await findUpcomingMeetingGoalForEvent(supabase, { ...who, calendarEventId: event_id, sinceMs: Date.now() - PREP_GOAL_LOOKBACK_MS })) ??
                    (anchorCaptureId && anchorUpcoming ? await findMeetingGoalForCapture(supabase, { ...who, captureId: anchorCaptureId }) : null))
                : anchorCaptureId
                  ? await findMeetingGoalForCapture(supabase, { ...who, captureId: anchorCaptureId })
                  : null
              return goal?.goal ?? null
            } catch {
              return null
            }
          })()
          const withGoal = async <T extends object>(result: T) => {
            const goal = await goalLoad
            return goal ? { ...result, meeting_goal: goal } : result
          }

          // Prior occurrences in the same series — the meeting's OWN history,
          // independent of attendee-email overlap (which EventKit events often
          // lack). Service-role client, so visibility is re-checked in TS the
          // same way step 3 does.
          let seriesCaptures: {
            id: string; title: string; summary: string | null; date: string; ai_processed: boolean
          }[] = []
          if (seriesKey || seriesIcalUid) {
            const column = seriesKey ? 'series_key' : 'ical_uid'
            const { data: sc } = await supabase
              .from('captures')
              .select('id, workspace_id, user_id, visibility, title, ai_summary, started_at, occurrence_start, created_at, ai_processed')
              .eq('workspace_id', workspaceId)
              .eq(column, (seriesKey || seriesIcalUid) as string)
              .neq('status', 'archived')
              .order('occurrence_start', { ascending: false, nullsFirst: false })
              .limit(6)
            seriesCaptures = ((sc || []) as Array<{
              id: string; workspace_id: string; user_id: string | null; visibility: string | null
              title: string; ai_summary: string | null; started_at: string | null
              occurrence_start: string | null; created_at: string; ai_processed: boolean
            }>)
              .filter((c) => c.id !== anchorCaptureId)
              .filter((c) => c.workspace_id === workspaceId && isCaptureVisible(c, requester))
              .slice(0, 5)
              .map((c) => ({
                id: c.id,
                title: c.title,
                summary: c.ai_summary?.substring(0, 300) || null,
                date: c.occurrence_start || c.started_at || c.created_at,
                ai_processed: c.ai_processed,
              }))
          }

          if (!participantEmails.length && !seriesCaptures.length) {
            return withGoal({
              success: true,
              event_title: eventTitle || 'Unknown',
              message: 'No participants found for this meeting. Try specifying a participant email.',
              recent_captures: [],
              open_actions: [],
              recent_decisions: [],
              attendee_knowledge: [],
            })
          }

          // 2. Find workspace members matching participant emails. There is no
          //    member.email column: a member's address lives on auth.users and
          //    is resolved through the admin API (workspace-member-emails.ts).
          const members = [...(await findMembersByEmail(workspaceId, participantEmails)).values()].map(
            (m) => ({ id: m.id, display_name: m.displayName }),
          )

          const memberIds = members.map((m) => m.id)

          // Also resolve participant emails to workspace contacts — external
          // attendees (non-members) have their commitments/facts scoped via
          // about→contact edges, not subject_member_id. Same email-match
          // convention used across the CRM (email-context-service.ts:74-78).
          const { data: contacts } = await supabase
            .from('contact')
            .select('id, full_name')
            .eq('workspace_id', workspaceId)
            .in('email', participantEmails)

          // Service-role client: RLS does not hide another member's private
          // contact here, so fence each row against the caller (fails closed).
          // A hidden contact contributes no name, assignee label or knowledge.
          const contactRows = await filterVisibleContacts(
            supabase,
            userId,
            (contacts || []) as { id: string; full_name: string | null }[],
          )
          const contactIds = contactRows.map((c) => c.id)

          // 3. Search for recent captures involving these participants (by email).
          //    The embed is !inner and carries workspace_id + visibility so the
          //    join filters actually drop rows: this query previously had NO
          //    workspace filter at all, and runs on a service-role client.
          const { data: recentCaptures } = await applyEmbeddedCaptureVisibility(
            supabase
              .from('capture_participant')
              .select(`
                capture:captures!capture_id!inner(id, workspace_id, user_id, visibility, title, ai_summary, started_at, created_at, ai_processed)
              `)
              .in('external_email', participantEmails)
              .eq('capture.workspace_id', workspaceId)
              // PostgREST binds embedded order/filter params by the embed's ALIAS
              // ("capture"), not the underlying table name — keying this on
              // `captures` makes the ordering silently inert.
              .order('created_at', { ascending: false, referencedTable: 'capture' })
              // One row per PARTICIPANT, and the embed order does not order these
              // rows: over-fetch, then dedupe and sort by recency below.
              .limit(50),
            requester,
            'capture',
          )

          const captureResults = (recentCaptures || [])
            .map((r) => {
              const c = r.capture as unknown as {
                id: string; workspace_id: string; user_id: string | null; visibility: string | null
                title: string; ai_summary: string | null
                started_at: string | null; created_at: string; ai_processed: boolean
              } | null
              if (!c) return null
              // Defense-in-depth: the service-role client bypasses RLS, so
              // re-check both fences in TS.
              if (c.workspace_id !== workspaceId) return null
              if (!isCaptureVisible(c, requester)) return null
              return {
                id: c.id,
                title: c.title,
                summary: c.ai_summary?.substring(0, 300) || null,
                date: c.started_at || c.created_at,
                ai_processed: c.ai_processed,
              }
            })
            .filter((c): c is NonNullable<typeof c> => c !== null)
            // A meeting shared by several attendees came back once per attendee.
            .filter((c, i, all) => all.findIndex((o) => o.id === c.id) === i)
            .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
            .slice(0, 5)

          // Series history first (this meeting's prior occurrences), then
          // attendee-overlap results that aren't already in the thread.
          const seriesIds = new Set(seriesCaptures.map((c) => c.id))
          const mergedCaptures = [
            ...seriesCaptures,
            ...captureResults.filter((c) => c && !seriesIds.has(c.id)),
          ].slice(0, 8)

          // 4. Find open actions assigned to these members OR to the external
          //    contacts (actions.assignee_contact_id → live `contact`).
          let actionResults: { id: string; title: string; assignee: string; due_at: string | null; status: string }[] = []
          if (memberIds.length || contactIds.length) {
            const assigneeClauses: string[] = []
            if (memberIds.length) assigneeClauses.push(`assignee_id.in.(${memberIds.join(',')})`)
            if (contactIds.length) assigneeClauses.push(`assignee_contact_id.in.(${contactIds.join(',')})`)
            const contactNameById = new Map(contactRows.map((c) => [c.id, c.full_name]))

            const { data: actions } = await supabase
              .from('actions')
              .select(`
                id, title, due_at, assignee_contact_id,
                assignee:member!assignee_id(display_name),
                workflow_state:workflow_state!status_id(name, category)
              `)
              .eq('workspace_id', workspaceId)
              .or(assigneeClauses.join(','))
              .neq('confirmation', 'dismissed')
              .limit(10)

            actionResults = (actions || [])
              .filter((a) => {
                const ws = a.workflow_state as unknown as { category: string } | null
                return ws?.category !== 'completed' && ws?.category !== 'canceled'
              })
              .map((a) => {
                const assignee = a.assignee as unknown as { display_name: string } | null
                const ws = a.workflow_state as unknown as { name: string } | null
                const contactName = a.assignee_contact_id
                  ? contactNameById.get(a.assignee_contact_id as string)
                  : null
                return {
                  id: a.id,
                  title: a.title,
                  assignee: assignee?.display_name || contactName || 'Unassigned',
                  due_at: a.due_at,
                  status: ws?.name || 'Unknown',
                }
              })
          }

          // 5. Find recent decisions involving these participants
          const captureIdsForDecisions = mergedCaptures.map((c) => c!.id)
          let decisionResults: { content: string; capture_title: string }[] = []
          if (captureIdsForDecisions.length) {
            const { data: decisions } = await supabase
              .from('decision')
              .select('content, capture:captures!capture_id(title)')
              .in('capture_id', captureIdsForDecisions)
              .eq('confirmation', 'confirmed')
              .limit(5)

            decisionResults = (decisions || []).map((d) => {
              const cap = d.capture as unknown as { title: string } | null
              return {
                content: d.content,
                capture_title: cap?.title || 'Unknown',
              }
            })
          }

          // 6. Attendee knowledge — what the knowledge graph knows about the
          // people in this meeting (their commitments, facts, open questions).
          // Two claim sets, both active + not-dismissed, capped combined:
          //   (a) subject_member_id ∈ members (internal attendees)
          //   (b) about→contact edges (either direction, any relation) —
          //       external participants' commitments from record_commitment.
          // Best-effort: any failure degrades to [] and never breaks prep.
          const CLAIM_CAP = 8
          type ClaimRow = {
            id: string
            text: string
            type: string
            confirmation: string
            event_at: string | null
            created_at: string
            subject_member_id: string | null
          }
          const memberNameById = new Map(
            (members || []).map((m) => [m.id, m.display_name as string | null]),
          )
          let attendeeKnowledge: {
            claim_id: string
            text: string
            type: string
            confirmation: string
            event_at: string | null
            about: string | null
          }[] = []
          try {
            // Resolve contact-linked claim ids from entity_link (both directions).
            const contactClaimIdToContactId = new Map<string, string>()
            if (contactIds.length) {
              const [outbound, inbound] = await Promise.all([
                // claim --(edge)--> contact
                supabase
                  .from('entity_link')
                  .select('source_id, target_id')
                  .eq('workspace_id', workspaceId)
                  .eq('source_type', 'claim')
                  .eq('target_type', 'contact')
                  .in('target_id', contactIds),
                // contact --(edge)--> claim
                supabase
                  .from('entity_link')
                  .select('source_id, target_id')
                  .eq('workspace_id', workspaceId)
                  .eq('source_type', 'contact')
                  .eq('target_type', 'claim')
                  .in('source_id', contactIds),
              ])
              for (const e of outbound.data || []) {
                contactClaimIdToContactId.set(e.source_id as string, e.target_id as string)
              }
              for (const e of inbound.data || []) {
                contactClaimIdToContactId.set(e.target_id as string, e.source_id as string)
              }
            }
            const contactClaimIds = [...contactClaimIdToContactId.keys()]

            const CLAIM_COLS =
              'id, text, type, confirmation, event_at, created_at, subject_member_id'
            const [memberClaimsRes, contactClaimsRes] = await Promise.all([
              memberIds.length
                ? supabase
                    .from('claim')
                    .select(CLAIM_COLS)
                    .eq('workspace_id', workspaceId)
                    .eq('status', 'active')
                    .neq('confirmation', 'dismissed')
                    .in('subject_member_id', memberIds)
                    .order('event_at', { ascending: false, nullsFirst: false })
                    .order('created_at', { ascending: false })
                    .limit(CLAIM_CAP)
                : Promise.resolve({ data: [] as ClaimRow[] }),
              contactClaimIds.length
                ? supabase
                    .from('claim')
                    .select(CLAIM_COLS)
                    .eq('workspace_id', workspaceId)
                    .eq('status', 'active')
                    .neq('confirmation', 'dismissed')
                    .in('id', contactClaimIds)
                    .order('event_at', { ascending: false, nullsFirst: false })
                    .order('created_at', { ascending: false })
                    .limit(CLAIM_CAP)
                : Promise.resolve({ data: [] as ClaimRow[] }),
            ])

            const contactNameById = new Map(contactRows.map((c) => [c.id, c.full_name]))
            const seen = new Set<string>()
            const merged: ClaimRow[] = []
            for (const row of [
              ...((memberClaimsRes.data || []) as ClaimRow[]),
              ...((contactClaimsRes.data || []) as ClaimRow[]),
            ]) {
              if (seen.has(row.id)) continue
              seen.add(row.id)
              merged.push(row)
            }
            // A claim is readable only when one of its sources is, and never
            // when one is mail (migration 341). This runs service-role, so the
            // rule is applied here; a failed check returns no claims.
            const combined = await excludeClaimsHiddenFrom(supabase, merged, requester)
            // Re-sort the merged set by event time (fallback created_at) and cap.
            combined.sort((a, b) => {
              const ta = Date.parse(a.event_at || a.created_at)
              const tb = Date.parse(b.event_at || b.created_at)
              return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
            })
            attendeeKnowledge = combined.slice(0, CLAIM_CAP).map((c) => {
              const about = c.subject_member_id
                ? memberNameById.get(c.subject_member_id) ?? null
                : contactNameById.get(contactClaimIdToContactId.get(c.id) ?? '') ?? null
              return {
                claim_id: c.id,
                text: c.text,
                type: c.type,
                confirmation: c.confirmation,
                event_at: c.event_at,
                about,
              }
            })
          } catch {
            attendeeKnowledge = []
          }

          return withGoal({
            success: true,
            event_title: eventTitle,
            participants: participantEmails,
            recent_captures: mergedCaptures,
            open_actions: actionResults,
            recent_decisions: decisionResults,
            attendee_knowledge: attendeeKnowledge,
          })
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to prepare meeting',
          }
        }
      },
    }),
  }
}
