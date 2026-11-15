/**
 * A Code tab job's turn, in its conversation's stored history (code-thread.ts
 * says what is stored). The work recorder hands a turn's report here instead
 * of writing a teammate's report (chat-report.ts deliverWorkReport, for a
 * ledger row whose source says `local_agent_code`): when the turn ends with
 * a result (needs_review, or done), its finish summary goes in as one
 * assistant message, in the conversation the person started it from. It is
 * the coding agent's words: every reader of the history renders it as a
 * fenced "Coding agent report" line (code-thread.ts codeFinishTranscriptLine). A
 * question, a failure or a stop writes nothing: the job's own view in the
 * chat shows those, and the push still goes. No home turn follows: no chat
 * model speaks between the person and their coding agent.
 *
 * The person's follow-ups, typed in the job's own chat (its composer, or the
 * Agents panel's steer), go in too, as their own user messages naming the
 * job (recordCodeFollowUp, from those person routes): the knowledge
 * extraction reads the person's words, never the transcript.
 *
 * Idempotent: the message id is one per job and turn (codeFinishMessageId),
 * and persistEveMessage converges a retried settle on the row already there.
 * Only a new row fires `conversation/activity` (the knowledge extraction's
 * debounced trigger, src/lib/inngest/conversation-ingest.ts). Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import { CODE_FINISH_KIND, CODE_MESSAGE_METADATA_KEY, LOCAL_AGENT_CODE_SOURCE_KEY, codeFinishMessageId, codeMessageId, codeRequestIdOf } from './code-thread'

export interface CodeFinishInput {
  conversationId: string
  userId: string
  workspaceId: string
  sessionId: string
  turn: number
  summary: string | null
}

export interface CodeHistoryDeps {
  send?: (event: { name: 'conversation/activity'; data: { workspaceId: string; userId: string; conversationId: string } }) => Promise<unknown>
}

/** A ledger row of a Code tab job (its source, as ledger.ts startTurnRow writes it). */
export function isCodeJobRow(row: { kind?: string; source?: Record<string, unknown> | null }): boolean {
  return row.kind === 'local_agent' && row.source?.[LOCAL_AGENT_CODE_SOURCE_KEY] === true
}

/** Write the turn's finish summary (once). True when a new message landed. */
export async function writeCodeFinish(svc: SupabaseClient, input: CodeFinishInput, deps: CodeHistoryDeps = {}): Promise<boolean> {
  const text = (input.summary ?? '').trim()
  if (!text || !input.sessionId || !Number.isSafeInteger(input.turn) || input.turn < 1) return false
  try {
    const result = await persistEveMessage(svc, {
      conversationId: input.conversationId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      role: 'assistant',
      messageId: codeFinishMessageId(input.sessionId, input.turn),
      parts: [{ type: 'text', text }],
      metadata: { kind: CODE_FINISH_KIND, local_agent_session_id: input.sessionId, turn: input.turn },
    })
    if (!result.written) {
      if (result.reason) console.warn(`[local-agent] code finish skipped (${result.reason}) for session ${input.sessionId}`)
      return false
    }
    try {
      await (deps.send ?? ((e) => inngest.send(e)))({
        name: 'conversation/activity',
        data: { workspaceId: input.workspaceId, userId: input.userId, conversationId: input.conversationId },
      })
    } catch {
      // Knowledge extraction is best-effort; the summary is stored.
    }
    return true
  } catch (err) {
    console.warn('[local-agent] code finish failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * A message the person sent a Code job from its own chat, kept in the
 * conversation's history as theirs (one user message, id codeMessageId of
 * the send's request id, naming the job): what the knowledge extraction may
 * read of a follow-up. Nothing for any other job, or one with no
 * conversation. Written once per request id; a new row fires the knowledge
 * trigger. Never throws.
 */
export async function recordCodeFollowUp(
  svc: SupabaseClient,
  input: { userId: string; sessionId: string; text: string; requestId: string },
  deps: CodeHistoryDeps = {},
): Promise<boolean> {
  try {
    const text = input.text.trim()
    if (!text || !input.requestId) return false
    // Read late: the store reaches this module through the ledger and the recorder.
    const { loadSession } = await import('./store')
    const row = await loadSession(svc, input.userId, input.sessionId)
    if (!row || row.started_by !== 'person' || !codeRequestIdOf(row.idempotency_key) || !row.conversation_id) return false
    const result = await persistEveMessage(svc, {
      conversationId: row.conversation_id,
      userId: input.userId,
      workspaceId: row.workspace_id,
      role: 'user',
      messageId: codeMessageId(input.requestId),
      parts: [{ type: 'text', text }],
      metadata: { [CODE_MESSAGE_METADATA_KEY]: { requestId: input.requestId, sessionId: row.id }, createdAt: new Date().toISOString() },
    })
    if (!result.written) return false
    try {
      await (deps.send ?? ((e) => inngest.send(e)))({
        name: 'conversation/activity',
        data: { workspaceId: row.workspace_id, userId: input.userId, conversationId: row.conversation_id },
      })
    } catch {
      // Knowledge extraction is best-effort; the message is stored.
    }
    return true
  } catch (err) {
    console.warn('[local-agent] code follow-up not kept:', err instanceof Error ? err.message : err)
    return false
  }
}
