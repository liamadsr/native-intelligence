/**
 * A chat-requested run reports back in the conversation that asked for it
 * (bots v2, phase 7; the vocabulary is src/lib/chat/teammate-report.ts).
 *
 * The recorder calls `reportWorkToChat` on a WON transition of a row with
 * `origin = 'chat'` and a `source.chat_conversation_id` (the root main chat's
 * `start_helper` started) into needs_review, needs_input, failed or canceled,
 * the same way it sends `work_needs_you`: a side effect of status, never a
 * producer's own call. It appends ONE assistant message to that conversation
 * through the eve message writer (persistEveMessage), which re-derives the
 * conversation's owner and refuses to write unless it is the run owner in the
 * run's workspace. Its id is stable per run and status, so a retried settle
 * that does reach here converges on the row already written.
 *
 * Not knowledge: no `conversation/activity` event fires for it (a report is
 * the ledger speaking, not a turn the weaver should mine). The notification is
 * unchanged and still opens the work item.
 *
 * EVERY REPORT GOES HOME (the one-chat rework: side chats no longer exist,
 * and the live agent's chat moves into the HUD). A helper started in the
 * person's home thread reports there; one started anywhere else (a capture's
 * live conversation, an old side chat, helpers still running from before the
 * cutover) reports into the owner's HOME thread in that workspace
 * (chat_conversations.is_home, migration 330), the message noting where it was
 * asked. Only a person with no home thread yet gets it where it was asked.
 *
 * A QUESTION ALWAYS ASKS AT HOME (P13; Liam, 2026-10-20: questions live in
 * the chat, never in For you). A run parked on a question (needs_input) that
 * no chat asked for (a loop's run, a Start, a coding run's pre-check) reports
 * too, into the owner's home thread (`chat_conversation_id` null), and the
 * chat renders the question card under the report (chat-ask-card.tsx
 * RunQuestionInline), answered there through the run's respond route. A
 * coding run's question names its action ("ENG-42's run has a question").
 *
 * A report that landed in the home thread also asks for a server turn there:
 * `home/turn.requested` (A4 slice 5), so the agent can decide whether to tell
 * the person (always-on-agent §4c, Liam's call 1: one batched turn,
 * debounced, that may stay quiet). This module only sends the event; the
 * consumer debounces and runs the turn. A report a retry converged on
 * (nothing new written), a muted one (a meeting prep), or a question (its
 * card asks by itself: a turn would only say it again) sends nothing.
 *
 * ONE TELLING. The recorder sends no `work_needs_you` push for a RESULT that
 * went home (deliverWorkReport's `muted`, ready for review): the home turn
 * decides whether the person hears about it now (no_reply allowed), and that
 * turn marks the item's inbox rows delivered, so "while you were away" and the
 * digest don't repeat it. A question or a failure keeps its push, and a quiet
 * turn leaves those rows for the away section.
 *
 * A MEETING PREP'S REPORT KNOWS ITS MEETING (Liam, 2026-10-17): a muted row
 * whose run is a meeting prep (agent_run.server_helper 'meeting_prep', read
 * back by src/lib/agent-events/prep-doc.ts meetingPrepForRun) records
 * `metadata.meeting_prep` (its start and end, calendar event, pending capture
 * and meeting key: enough to find the meeting again), and its report names the
 * meeting's start in the person's zone (the model's line about it says which
 * meeting it is for). Ready for review, its documents are stamped as the prep
 * for that meeting (document.frontmatter.meeting_prep), which the cards note
 * labels with the meeting's time and whether it is over.
 *
 * Best-effort, never throws: the row has already moved; a lost report is a
 * missing line in the chat, never a failed settle.
 */

/** The event a helper's report in a home thread sends (consumer: the server home turn, A4 slice 5). */
export const HOME_TURN_REQUESTED = 'home/turn.requested' as const

/** Payload of {@link HOME_TURN_REQUESTED}. */
export interface HomeTurnRequestedEvent {
  id?: string
  name: typeof HOME_TURN_REQUESTED
  data: {
    conversationId: string
    userId: string
    workspaceId: string
    /** The ledger rows whose reports landed (one per event today; the consumer batches). */
    workItemIds: string[]
    reason: 'helper_report'
  }
}

export interface ChatReportDeps {
  send?: (event: HomeTurnRequestedEvent) => Promise<unknown>
}
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import { resolveHomeConversation } from '@/lib/onboarding/home-conversation-pointer'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { meetingWhen } from '@/lib/agent-events/meeting-time'
import { MEETING_PREP_KEY, markPrepDocuments, meetingPrepForRun } from '@/lib/agent-events/prep-doc'
import { enrichOfferFor } from '@/lib/agent-events/meeting-prep'
import {
  LOCAL_AGENT_INTERRUPTED_NEEDS_ID,
  LOCAL_AGENT_TEAMMATE_NEEDS_ID,
  TEAMMATE_REPORT_KIND,
  TEAMMATE_REPORT_PART_TYPE,
  buildTeammateReport,
  partDeliverable,
  teammateReportMessageId,
  teammateReportText,
  type TeammateReportPartData,
  type TeammateReportStatus,
} from '@/lib/chat/teammate-report'
import { questionText } from './notify'
import { primaryDeliverable } from './presentation'
import { NO_REPORT_BACK } from './reaper'
import { WORK_ROLE_LABELS, isWorkRole } from './roles'
import type { WorkDeliverable, WorkNeeds, WorkSource } from './types'

/** What the recorder knows about the row at the transition. */
export interface ChatReportRow {
  id: string
  workspace_id: string
  member_id: string
  title: string
  agent_run_id: string | null
  ai_team_member_id: string | null
  /** The chat that asked; null for a question no chat asked for (it goes to the owner's home thread). */
  chat_conversation_id: string | null
  /** The row's kind and back-references: a local agent's report names its folder and session. */
  kind?: string
  source?: WorkSource | null
  needs: WorkNeeds | null
  deliverables: WorkDeliverable[]
  result_summary: string | null
  error_message: string | null
  /**
   * A muted row (a server-started helper, A6 slice 5: a meeting prep): its
   * report still lands in the thread, but asks for no home turn (the
   * meeting-soon notice already says the prep is ready).
   */
  quiet?: boolean
}

const USAGE_LIMIT_RE = /usage limit/i

/** A failure in a few words: the known ones said plainly, anything else as written. */
export function failureReason(error: string | null | undefined): string | null {
  const err = (error ?? '').trim()
  if (!err) return null
  if (USAGE_LIMIT_RE.test(err)) return 'the AI usage limit was reached'
  if (err === NO_REPORT_BACK) return 'it stopped reporting back'
  return err
}

/** The first question's id, when the asker gave one (a local agent's interruption is keyed on it). */
function firstQuestionId(needs: WorkNeeds | null): string | null {
  if (needs?.kind !== 'input') return null
  const q = needs.questions[0] as { id?: unknown } | null | undefined
  return q && typeof q === 'object' && typeof q.id === 'string' ? q.id : null
}

/** The teammate's name, else its role's, else a generic one (the builder's default). */
function teammateName(row: { name?: unknown; role?: unknown } | null): string | null {
  if (typeof row?.name === 'string' && row.name.trim()) return row.name
  return isWorkRole(row?.role) ? WORK_ROLE_LABELS[row.role] : null
}

/** Where a report went, for the recorder. */
export interface WorkReportOutcome {
  /** A new message landed. */
  written: boolean
  /** It went to (or already sits in) the owner's home thread. */
  home: boolean
  /** The conversation it went to (null: nothing was tried). */
  conversationId: string | null
  /**
   * The report is in the home thread (newly, or a retry converged on it),
   * where the home turn decides: the recorder leaves out the push for a
   * result (ready for review), never for a question or a failure.
   */
  muted: boolean
}

/** Append the report for `status` to the row's conversation. True when a new message landed. */
export async function reportWorkToChat(
  supabase: SupabaseClient,
  row: ChatReportRow,
  status: TeammateReportStatus,
  deps: ChatReportDeps = {},
): Promise<boolean> {
  return (await deliverWorkReport(supabase, row, status, deps)).written
}

/**
 * Where a report goes: the asking conversation when it is the owner's home
 * thread; else the owner's home thread in the workspace; else (no home thread
 * yet, or the read failed) the asking conversation. Never throws.
 */
export async function reportTarget(
  supabase: SupabaseClient,
  args: { conversationId: string; userId: string; workspaceId: string },
): Promise<{ conversationId: string; home: boolean; rerouted: boolean }> {
  const asked = { conversationId: args.conversationId, home: false, rerouted: false }
  try {
    const { data: conv, error } = await supabase
      .from('chat_conversations')
      .select('id, is_home')
      .eq('id', args.conversationId)
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error) return asked
    if ((conv as { is_home?: unknown } | null)?.is_home === true) return { conversationId: args.conversationId, home: true, rerouted: false }
    const { data: home, error: homeError } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .eq('is_home', true)
      .limit(1)
    const homeId = homeError ? null : (home as Array<{ id?: unknown }> | null)?.[0]?.id
    return typeof homeId === 'string' ? { conversationId: homeId, home: true, rerouted: true } : asked
  } catch {
    return asked
  }
}

/** The owner's home thread in the workspace (made if they have none yet), or null when it can't be had. Never throws. */
async function homeTarget(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string },
): Promise<{ conversationId: string; home: boolean; rerouted: boolean } | null> {
  try {
    const home = await resolveHomeConversation(supabase, args)
    return home ? { conversationId: home.conversationId, home: true, rerouted: false } : null
  } catch {
    return null
  }
}

/** The identifier (ENG-42) of the action a coding run works, or null. Never throws. */
async function runActionIdentifier(supabase: SupabaseClient, workspaceId: string, agentRunId: string): Promise<string | null> {
  try {
    const { data: run } = await supabase.from('agent_run').select('action_id').eq('id', agentRunId).eq('workspace_id', workspaceId).maybeSingle()
    const actionId = (run as { action_id?: unknown } | null)?.action_id
    if (typeof actionId !== 'string' || !actionId) return null
    const { data: action } = await supabase.from('actions').select('identifier').eq('id', actionId).eq('workspace_id', workspaceId).maybeSingle()
    const identifier = (action as { identifier?: unknown } | null)?.identifier
    return typeof identifier === 'string' && /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(identifier) ? identifier : null
  } catch {
    return null
  }
}

/** Append the report for `status` to the owner's home thread (see the header), and say where it went. Never throws. */
export async function deliverWorkReport(
  supabase: SupabaseClient,
  row: ChatReportRow,
  status: TeammateReportStatus,
  deps: ChatReportDeps = {},
): Promise<WorkReportOutcome> {
  const none: WorkReportOutcome = { written: false, home: false, conversationId: null, muted: false }
  try {
    const [owner, teammate] = await Promise.all([
      supabase.from('member').select('user_id').eq('id', row.member_id).eq('workspace_id', row.workspace_id).maybeSingle(),
      row.ai_team_member_id
        ? supabase
            .from('ai_team_member')
            .select('name, role')
            .eq('id', row.ai_team_member_id)
            .eq('workspace_id', row.workspace_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    const userId = (owner.data as { user_id?: unknown } | null)?.user_id
    if (typeof userId !== 'string' || !userId) return none
    const target = row.chat_conversation_id
      ? await reportTarget(supabase, { conversationId: row.chat_conversation_id, userId, workspaceId: row.workspace_id })
      : await homeTarget(supabase, { userId, workspaceId: row.workspace_id })
    if (!target) return none
    // A coding run's question names its action (ENG-42), read off the run.
    const identifier = status === 'needs_input' && row.agent_run_id ? await runActionIdentifier(supabase, row.workspace_id, row.agent_run_id) : null
    // A meeting prep (always a muted row): which meeting, and its start in the person's zone.
    const prep = row.quiet && row.agent_run_id ? await meetingPrepForRun(supabase, { workspaceId: row.workspace_id, agentRunId: row.agent_run_id }) : null
    const meetingLabel = prep ? meetingWhen(prep.ref.startIso, (await readMemberTimeZone(supabase, { workspaceId: row.workspace_id, userId })).timeZone) : ''
    // Its offer to enrich the attendees not enriched yet, re-checked now (meeting-prep.ts).
    const enrichOffer =
      prep && prep.enrichContactIds.length > 0 && (status === 'done' || status === 'needs_review')
        ? await enrichOfferFor(supabase, { workspaceId: row.workspace_id, userId, contactIds: prep.enrichContactIds })
        : []

    const report = buildTeammateReport({
      runId: row.agent_run_id,
      workItemId: row.id,
      workspaceId: row.workspace_id,
      status,
      teammateId: row.ai_team_member_id,
      teammateName: teammateName(teammate.data as { name?: unknown; role?: unknown } | null),
      title: row.title,
      deliverables: row.deliverables,
      question: questionText(row.needs),
      reason: failureReason(row.error_message),
      summary: row.result_summary,
      ...(identifier ? { identifier } : {}),
      ...(prep && meetingLabel ? { meeting: { startIso: prep.ref.startIso, label: meetingLabel } } : {}),
      ...(enrichOffer.length > 0 ? { enrichOffer } : {}),
      ...(row.kind === 'local_agent'
        ? {
            localAgent: {
              sessionId: row.source?.local_agent_session_id,
              folderLabel: row.source?.folder_label,
              interrupted: status === 'needs_input' && firstQuestionId(row.needs) === LOCAL_AGENT_INTERRUPTED_NEEDS_ID,
              deviceName: row.source?.device_name,
              toTeammate: status === 'needs_input' && firstQuestionId(row.needs) === LOCAL_AGENT_TEAMMATE_NEEDS_ID,
            },
          }
        : {}),
    })
    // A result opens to its output, not the run (Liam, 10-15): the primary deliverable rides on the chip.
    const output = status === 'needs_review' || status === 'done' ? partDeliverable(primaryDeliverable(row)) : null
    const chip: TeammateReportPartData = {
      work_item_id: row.id,
      workspace_id: row.workspace_id,
      status,
      title: report.title,
      ...(output ? { deliverable: output } : {}),
    }
    const messageId = teammateReportMessageId({ runId: row.agent_run_id, workItemId: row.id, status, question: report.question })
    const result = await persistEveMessage(supabase, {
      conversationId: target.conversationId,
      userId,
      workspaceId: row.workspace_id,
      role: 'assistant',
      messageId,
      parts: [
        { type: 'text', text: teammateReportText(report) },
        { type: TEAMMATE_REPORT_PART_TYPE, data: chip },
      ],
      metadata: {
        kind: TEAMMATE_REPORT_KIND,
        teammate_report: report,
        // Asked somewhere else (a capture's live chat, an old side chat): where.
        ...(target.rerouted && row.chat_conversation_id ? { asked_in_conversation_id: row.chat_conversation_id } : {}),
        ...(prep ? { [MEETING_PREP_KEY]: prep.ref } : {}),
      },
    })
    // The prep's documents, stamped as the prep for its meeting (the cards note labels them).
    if (prep && status === 'needs_review') {
      await markPrepDocuments(supabase, { workspaceId: row.workspace_id, userId, ref: prep.ref, deliverables: row.deliverables })
    }
    if (!result.written && result.reason) {
      console.warn(`[work] chat report skipped (${result.reason}) for item ${row.id}`)
    }
    if (result.written && target.home && !row.quiet && status !== 'needs_input') {
      await requestHomeTurn({ conversationId: target.conversationId, userId, workspaceId: row.workspace_id, workItemId: row.id, reportId: messageId }, deps)
    }
    // In the home thread now (written, or a retry converged on it): the home turn decides, no push.
    const landed = result.written || !result.reason
    return { written: result.written, home: target.home, conversationId: target.conversationId, muted: target.home && landed }
  } catch (err) {
    console.error('[work] reportWorkToChat failed:', err instanceof Error ? err.message : err)
    return none
  }
}

/**
 * Ask for a server turn in the home thread a report just landed in
 * (reportTarget read it, fenced on owner and workspace). Never throws: a lost
 * request leaves the report and the "Teammate updates" section, as before A4.
 */
async function requestHomeTurn(
  args: { conversationId: string; userId: string; workspaceId: string; workItemId: string; reportId: string },
  deps: ChatReportDeps,
): Promise<void> {
  try {
    const event: HomeTurnRequestedEvent = {
      // One request per report message (its id is stable per run and status).
      id: `home-turn-requested:${args.reportId}`,
      name: HOME_TURN_REQUESTED,
      data: {
        conversationId: args.conversationId,
        userId: args.userId,
        workspaceId: args.workspaceId,
        workItemIds: [args.workItemId],
        reason: 'helper_report',
      },
    }
    await (deps.send ?? ((e) => inngest.send(e as never)))(event)
  } catch (err) {
    console.warn('[work] home turn request failed:', err instanceof Error ? err.message : String(err))
  }
}
