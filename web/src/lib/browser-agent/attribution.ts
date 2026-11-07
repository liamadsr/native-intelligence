/** Server-authored correlation only. None of these fields belong in model tool input. */
export interface BrowserCommandAttribution {
  version: 1
  source: 'chat_agent'
  parent_run_id: string
  conversation_id: string
  workspace_id: string
  eve_session_id: string
  eve_turn_id: string
  eve_call_id: string
}

/** The same session/turn identity as the existing once-per-turn usage bill. */
export function chatParentRunId(sessionId: string, turnId: string): string {
  return `ai_chat:${sessionId}:${turnId}`
}

/** Called only after internal-secret and chat-run-token verification. Runtime
 * coordinates come from Eve's proxy envelope, tenancy from signed claims.
 * Missing/legacy coordinates stay unattributed rather than guessed by time. */
export function browserCommandAttribution(
  scope: { conversationId: string; workspaceId: string; surface?: string },
  runtime: { sessionId?: unknown; turnId?: unknown; callId?: unknown },
): BrowserCommandAttribution | undefined {
  const keyPart = (value: unknown): value is string => typeof value === 'string' && /^[^:\s]{1,200}$/.test(value)
  if (scope.surface || !keyPart(runtime.sessionId) || !keyPart(runtime.turnId) ||
      typeof runtime.callId !== 'string' || !runtime.callId.trim() || runtime.callId.length > 200) return undefined
  return { version: 1, source: 'chat_agent',
    parent_run_id: chatParentRunId(runtime.sessionId, runtime.turnId),
    conversation_id: scope.conversationId, workspace_id: scope.workspaceId,
    eve_session_id: runtime.sessionId, eve_turn_id: runtime.turnId, eve_call_id: runtime.callId }
}
