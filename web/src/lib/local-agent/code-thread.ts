/**
 * What a Code tab job leaves in its conversation's stored history
 * (chat_messages), and how the chat finds it again. Client-safe.
 *
 *   the person's message   a user message, written by the composer's save
 *                          (use-chat-auto-save.ts), its metadata naming the
 *                          send (CODE_MESSAGE_METADATA_KEY: the request id,
 *                          and the job once the send went to a running one)
 *   the agent's finish     an assistant message the server writes when a
 *                          turn ends (code-history.ts): the finish summary as
 *                          plain text, its metadata naming the job and turn
 *
 * Nothing else of the job's transcript is stored there: its tool steps,
 * text and questions stay in the job's own events. The workspace's knowledge
 * extraction reads these two kinds like any other chat text.
 */

/** Why the Code tab doesn't send with a cloud environment (the route refuses it too, CODE_CLOUD_NEXT). */
export const CODE_CLOUD_NEXT_REASON = 'Coding in the cloud from here comes next. Pick one of your Macs to code on it now.'

/** A Code job's ledger rows say so in their source (ledger.ts startTurnRow; chat-report.ts reads it). */
export const LOCAL_AGENT_CODE_SOURCE_KEY = 'local_agent_code' as const

/** The metadata key of the person's Code message. */
export const CODE_MESSAGE_METADATA_KEY = 'local_agent_code' as const

/** The kind of the agent's finish message (metadata.kind). */
export const CODE_FINISH_KIND = 'local_agent_code_finish' as const

export interface CodeMessageMeta {
  /** The send's request id (the job's key carries it when the send started one). */
  requestId: string
  /** The job the send went to as its next turn, when it went to a running one. */
  sessionId?: string
}

/** The finish message's stable id: one per job and turn, so a retried settle writes nothing new. */
export function codeFinishMessageId(sessionId: string, turn: number): string {
  return `local-agent-code-finish:${sessionId}:${turn}`
}

/** The person's Code message's own id (the chat and the save converge on it). */
export function codeMessageId(requestId: string): string {
  return `code-${requestId}`
}

const metaOf = (message: unknown): Record<string, unknown> | null => {
  const meta = (message as { metadata?: unknown } | null)?.metadata
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null
}

/** The Code send a user message carries, or null for any other message. */
export function codeMessageMetaOf(message: unknown): CodeMessageMeta | null {
  if ((message as { role?: unknown } | null)?.role !== 'user') return null
  const raw = metaOf(message)?.[CODE_MESSAGE_METADATA_KEY]
  if (!raw || typeof raw !== 'object') return null
  const { requestId, sessionId } = raw as { requestId?: unknown; sessionId?: unknown }
  if (typeof requestId !== 'string' || !requestId) return null
  return { requestId, ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}) }
}

/** The job an agent's finish message belongs to, or null for any other message. */
export function codeFinishSessionOf(message: unknown): string | null {
  if ((message as { role?: unknown } | null)?.role !== 'assistant') return null
  const meta = metaOf(message)
  if (meta?.kind !== CODE_FINISH_KIND) return null
  return typeof meta.local_agent_session_id === 'string' && meta.local_agent_session_id ? meta.local_agent_session_id : null
}
