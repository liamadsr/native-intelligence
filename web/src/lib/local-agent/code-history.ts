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
 * Idempotent: the message id is one per job and turn (codeFinishMessageId),
 * and persistEveMessage converges a retried settle on the row already there.
 * Only a new row fires `conversation/activity` (the knowledge extraction's
 * debounced trigger, src/lib/inngest/conversation-ingest.ts). Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import { CODE_FINISH_KIND, LOCAL_AGENT_CODE_SOURCE_KEY, codeFinishMessageId } from './code-thread'

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
