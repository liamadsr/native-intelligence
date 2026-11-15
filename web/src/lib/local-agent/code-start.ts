/**
 * A job the person starts from the chat composer's Code tab (POST
 * /api/local-agent/sessions): they work with a coding agent directly, with
 * no chat model in between. Only their own typed send reaches here (the
 * route is a session-authenticated person route); nothing unattended (a
 * loop, an automation, the chat agent) starts a job on their own coding
 * agent.
 *
 * The job edits from its first message, on its own branch (mode 'edit', the
 * Mac's worktree), in one of the person's folders on one of their Macs, on
 * the agent they picked: a coding agent that Mac offers, or Native
 * Intelligence's own agent (null). Its key carries the send's request id
 * (codeJobKey), so a retried send gets its first job back. The refusals are
 * createSession's (FOLDER_BUSY, a removed Mac, a read-only folder) and the
 * checks below, each a LocalAgentError with a sentence the composer shows.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { macEnvironmentId } from '@/lib/environments/mac'
import { WORKER_NOT_OFFERED_CODE, assertMacOffers } from '@/lib/environments/store'
import { EnvironmentError, isWorkerId } from '@/lib/environments/types'
import { CODE_CLOUD_NEXT_REASON } from './code-thread'
import {
  CODE_REQUEST_ID_RE,
  LocalAgentError,
  codeJobKey,
  createSession,
  findSessionByKey,
  isUuid,
  listFolders,
  type SessionRow,
} from './store'

type Svc = SupabaseClient

/** The cloud from the Code tab comes in a later phase (details.code; the sentence is code-thread.ts's, the composer says it too). */
export const CODE_CLOUD_NEXT_CODE = 'CODE_CLOUD_NEXT'
/** Code works on its own branch: the folder must be a git repository (details.code). */
export const NOT_A_REPOSITORY_CODE = 'NOT_A_REPOSITORY'

export interface CodeStartInput {
  userId: string
  /**
   * The window's workspace (requireWorkspace). The job starts in the chat's
   * own workspace, which may differ (ownChatWorkspace).
   */
  workspaceId: string
  conversationId: unknown
  folderId: unknown
  request: unknown
  /** A coding agent's id, or null for Native Intelligence's own agent. Required. */
  worker: unknown
  /** One per send: a retry with it gets the first job back. */
  requestId: unknown
  /** The chat's environment, when the composer names it: a cloud one is refused (CODE_CLOUD_NEXT). */
  environmentId?: unknown
}

export interface CodeStartResult {
  session: SessionRow
  created: boolean
  /** It went to a job of this chat already working in that folder on that agent, as its next turn. */
  joined: boolean
  deviceOnline: boolean
}

/** Start (or, for a retried send, find) the person's Code job. Refusals throw LocalAgentError. */
export async function startCodeJob(svc: Svc, input: CodeStartInput): Promise<CodeStartResult> {
  if (typeof input.requestId !== 'string' || !CODE_REQUEST_ID_RE.test(input.requestId)) {
    throw new LocalAgentError('bad_request', 'requestId must be a short id')
  }
  if (input.worker !== null && !isWorkerId(input.worker)) {
    throw new LocalAgentError('bad_request', 'worker must be a coding agent’s id, or null for Native Intelligence')
  }
  if (typeof input.request !== 'string' || !input.request.trim()) throw new LocalAgentError('bad_request', 'Say what to do')
  if (!isUuid(input.folderId)) throw new LocalAgentError('bad_request', 'folderId must be one of your folders')
  if (!isUuid(input.conversationId)) throw new LocalAgentError('bad_request', 'conversationId must be one of your chats')
  const key = codeJobKey(input.requestId)

  // A retried send: its first job, whatever changed since (the Mac's offers, the folder's mode).
  const existing = await findSessionByKey(svc, input.userId, key)
  if (existing) return { session: existing.session, created: false, joined: false, deviceOnline: existing.deviceOnline }

  // The chat's own workspace (a window whose active workspace is another
  // still starts it in the chat's, as the environments routes do).
  const workspaceId = await ownChatWorkspace(svc, input.userId, input.conversationId)
  if (input.environmentId !== undefined && input.environmentId !== null) await assertNotCloud(svc, input.environmentId)

  // Only the person's own live folders (listFolders reads their rows alone).
  const folder = (await listFolders(svc, input.userId)).find((f) => f.id === input.folderId)
  if (!folder) throw new LocalAgentError('not_found', 'That folder isn’t shared with Native Intelligence any more. Pick another one.')
  const mac = folder.deviceName || 'your Mac'
  if (folder.mode !== 'edit') {
    throw new LocalAgentError('forbidden', `${folder.label} on ${mac} is read-only. Allow edits for it on your Mac, then send again.`)
  }
  if (!folder.isGit) {
    throw new LocalAgentError('conflict', `${folder.label} isn’t a git repository. Code works on its own branch, so pick a folder that is one.`, {
      code: NOT_A_REPOSITORY_CODE,
    })
  }

  // A coding agent: only one that Mac last said it offers (it would refuse anything else, later).
  if (input.worker !== null) {
    const environmentId = await macEnvironmentId(svc, input.userId, folder.deviceId)
    if (!environmentId) {
      throw new LocalAgentError('conflict', 'This Mac hasn’t told Native Intelligence which coding agents it offers yet. Open Native Intelligence on it, then send again.', {
        code: WORKER_NOT_OFFERED_CODE,
      })
    }
    try {
      await assertMacOffers(svc, environmentId, input.worker)
    } catch (err) {
      if (!(err instanceof EnvironmentError)) throw err
      throw new LocalAgentError('conflict', err.message, err.details)
    }
  }

  const started = await createSession(svc, {
    userId: input.userId,
    workspaceId,
    folderId: folder.id,
    conversationId: input.conversationId,
    request: input.request,
    mode: 'edit',
    startedBy: 'person',
    idempotencyKey: key,
    explicitWorker: input.worker,
  })
  return { session: started.session, created: started.created, joined: started.joined === true, deviceOnline: started.deviceOnline }
}

/**
 * The person's own main-chat conversation, and the workspace it is in: never
 * a teammate's, a bot's or a guest's thread, an outside channel (Slack, SMS,
 * team chat) or a capture's conversation, and only in a workspace they are
 * still a member of. The window's active workspace may be another one (a
 * second window, a switch since): the chat's own is the one that counts, as
 * GET /api/account/environments/chat reads it.
 */
async function ownChatWorkspace(svc: Svc, userId: string, conversationId: string): Promise<string> {
  const { data, error } = await svc
    .from('chat_conversations')
    .select('id, workspace_id, ai_team_member_id, agent_teammate_id, agent_guest_id, outside_channel, capture_id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`conversation read failed: ${error.message}`)
  const row = data as {
    workspace_id?: unknown
    ai_team_member_id?: unknown
    agent_teammate_id?: unknown
    agent_guest_id?: unknown
    outside_channel?: unknown
    capture_id?: unknown
  } | null
  if (!row || typeof row.workspace_id !== 'string') throw new LocalAgentError('not_found', 'Conversation not found')
  if (row.ai_team_member_id || row.agent_teammate_id || row.agent_guest_id || row.outside_channel || row.capture_id) {
    throw new LocalAgentError('bad_request', 'Code runs from your own main chat, not from this conversation.')
  }
  const { data: member, error: memberError } = await svc.from('member').select('id').eq('workspace_id', row.workspace_id).eq('user_id', userId).maybeSingle()
  if (memberError) throw new Error(`membership read failed: ${memberError.message}`)
  if (!member) throw new LocalAgentError('not_found', 'Conversation not found')
  return row.workspace_id
}

/** A cloud environment is refused for now; a Mac (or one not found) leaves the folder to decide. */
async function assertNotCloud(svc: Svc, environmentId: unknown): Promise<void> {
  if (!isUuid(environmentId)) throw new LocalAgentError('bad_request', 'environmentId must be an environment’s id')
  const { data, error } = await svc.from('environment').select('kind').eq('id', environmentId).maybeSingle()
  if (error) throw new Error(`environment read failed: ${error.message}`)
  if ((data as { kind?: unknown } | null)?.kind === 'cloud') {
    throw new LocalAgentError('conflict', CODE_CLOUD_NEXT_REASON, { code: CODE_CLOUD_NEXT_CODE })
  }
}
