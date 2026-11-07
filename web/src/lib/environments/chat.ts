/**
 * A chat's environment (docs/plans/environments.md §3, §7 Q1): where the chat
 * agent sends work. Each chat has one, set in the composer and changeable at
 * any time; the agent uses another of the person's only when they ask in
 * words. Each job's environment is fixed when it starts (§4), so changing a
 * chat's never moves a running job.
 *
 * Resolution, in order (pickChatEnvironment):
 *   chat       the chat's own (chat_conversations.environment_id);
 *   default    the person's default for the chat's workspace: the one they
 *              picked last there (setChatEnvironment records it);
 *   mac        their first Mac in a stable order: online ones first, then
 *              the one added first (store.ts macOrder), so two Macs online
 *              never flip it from turn to turn;
 *   workspace  the workspace's default cloud environment;
 *   none       nothing: the agent asks where to run before it starts work.
 * The first time a turn or a start resolves it, it is pinned on the chat
 * (chat_conversations.environment_id), so a later pick in another chat, or a
 * Mac coming online, never moves it; only a pick in this chat does.
 * Each candidate counts only while this person may use it there: their own
 * Mac (not removed), or a live cloud environment of the chat's workspace that
 * is shared or theirs (migration 420's _environment_usable, in code). One that
 * was archived or unshared since is skipped, and the next one applies.
 *
 * `svc` is a service-role client; every function checks ownership itself (a
 * chat of someone else reads as missing).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid } from '@/lib/local-agent/store'
import { getDefault, listEnvironments, loadEnvironmentRow, memberRole, setDefault, usableBy } from './store'
import { EnvironmentError, type ChatEnvironmentSource, type ChatEnvironmentView, type Environment } from './types'

type Svc = SupabaseClient

/** What picking a chat's environment needs, already read. */
export interface ChatEnvironmentCandidates {
  /** chat_conversations.environment_id, or null (or no chat yet). */
  chatEnvironmentId: string | null
  /** The person's default for the chat's workspace (environment_default, project_id null), or null. */
  defaultEnvironmentId: string | null
  /** The person's Macs' environment ids in the stable order (store.ts macOrder: online first, then the first added; removed Macs left out). */
  macEnvironmentIds: readonly string[]
  /** workspace.default_cloud_environment_id, or null. */
  workspaceDefaultId: string | null
  /** May this person use it in the chat's workspace (their Mac; a live cloud one, shared or theirs)? */
  usable: (environmentId: string) => boolean
  /** A shared cloud environment (the workspace default must be one). */
  shared: (environmentId: string) => boolean
}

/** The chat's environment and where it came from (§7 Q1's order). Pure. */
export function pickChatEnvironment(c: ChatEnvironmentCandidates): { environmentId: string | null; source: ChatEnvironmentSource } {
  if (c.chatEnvironmentId && c.usable(c.chatEnvironmentId)) return { environmentId: c.chatEnvironmentId, source: 'chat' }
  if (c.defaultEnvironmentId && c.usable(c.defaultEnvironmentId)) return { environmentId: c.defaultEnvironmentId, source: 'default' }
  const mac = c.macEnvironmentIds.find((id) => c.usable(id))
  if (mac) return { environmentId: mac, source: 'mac' }
  if (c.workspaceDefaultId && c.usable(c.workspaceDefaultId) && c.shared(c.workspaceDefaultId)) {
    return { environmentId: c.workspaceDefaultId, source: 'workspace' }
  }
  return { environmentId: null, source: 'none' }
}

/** May this person send work to this listed environment (listEnvironments already drops what they can't see)? */
export function environmentUsable(e: Environment, userId: string): boolean {
  if (e.kind === 'mac') return true
  return !e.archivedAt && (e.shared || e.createdBy === userId)
}

interface ChatRow {
  id: string
  workspace_id: string
  environment_id: string | null
}

/** The person's own chat, or a not_found refusal. */
export async function loadOwnChat(svc: Svc, userId: string, conversationId: unknown): Promise<ChatRow> {
  if (!isUuid(conversationId)) throw new EnvironmentError('not_found', 'Conversation not found')
  const { data, error } = await svc
    .from('chat_conversations')
    .select('id, workspace_id, environment_id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`conversation read failed: ${error.message}`)
  if (!data) throw new EnvironmentError('not_found', 'Conversation not found')
  const row = data as { id: string; workspace_id: string; environment_id?: string | null }
  return { id: row.id, workspace_id: row.workspace_id, environment_id: row.environment_id ?? null }
}

async function workspaceDefaultId(svc: Svc, workspaceId: string): Promise<string | null> {
  const { data, error } = await svc.from('workspace').select('default_cloud_environment_id').eq('id', workspaceId).maybeSingle()
  if (error) throw new Error(`workspace default read failed: ${error.message}`)
  return (data as { default_cloud_environment_id?: string | null } | null)?.default_cloud_environment_id ?? null
}

/**
 * GET /api/account/environments/chat: the chat's environment, as
 * GET /api/account/environments shows it. With no conversation (a chat not
 * made yet), the same order from `default` on, in `workspaceId`.
 */
export async function resolveChatEnvironment(
  svc: Svc,
  args: { userId: string; workspaceId: string; conversationId?: string | null; pin?: boolean },
): Promise<ChatEnvironmentView> {
  const chat = args.conversationId ? await loadOwnChat(svc, args.userId, args.conversationId) : null
  const workspaceId = chat?.workspace_id ?? args.workspaceId
  const [environments, defaultEnvironmentId, wsDefault] = await Promise.all([
    listEnvironments(svc, { userId: args.userId, workspaceId }),
    getDefault(svc, { userId: args.userId, workspaceId }),
    workspaceDefaultId(svc, workspaceId),
  ])
  const byId = new Map(environments.map((e) => [e.id, e]))
  const picked = pickChatEnvironment({
    chatEnvironmentId: chat?.environment_id ?? null,
    defaultEnvironmentId,
    macEnvironmentIds: environments.filter((e) => e.kind === 'mac').map((e) => e.id),
    workspaceDefaultId: wsDefault,
    usable: (id) => {
      const e = byId.get(id)
      return !!e && environmentUsable(e, args.userId)
    },
    shared: (id) => {
      const e = byId.get(id)
      return e?.kind === 'cloud' && e.shared
    },
  })
  if (args.pin && chat && picked.environmentId && picked.source !== 'chat') await pinChatEnvironment(svc, args.userId, chat.id, picked.environmentId)
  return { ...picked, environment: picked.environmentId ? (byId.get(picked.environmentId) ?? null) : null }
}

/**
 * Pin a chat's environment the first time a turn or a start resolves it:
 * only a chat with none yet (a pick made meanwhile stands), and migration
 * 420's trigger checks it again. Best-effort: an unpinned chat resolves the
 * same way next time.
 */
export async function pinChatEnvironment(svc: Svc, userId: string, conversationId: string, environmentId: string): Promise<void> {
  const { error } = await svc
    .from('chat_conversations')
    .update({ environment_id: environmentId })
    .eq('id', conversationId)
    .eq('user_id', userId)
    .is('environment_id', null)
  if (error) console.warn('[environments] pinning the chat’s environment failed:', error.message)
}

/**
 * PUT /api/account/environments/chat: set the chat's environment (its owner
 * only), and record it as the person's default for the chat's workspace ("the
 * one you picked last here", §7 Q1). environmentId null clears the chat's, so
 * the next default applies; the default is left as it is. With no
 * conversation (a chat not made yet), only the default is set, in
 * `workspaceId`. Migration 420's trigger checks the chat's reference again.
 */
export async function setChatEnvironment(
  svc: Svc,
  args: { userId: string; workspaceId: string; conversationId?: unknown; environmentId: unknown },
): Promise<{ environmentId: string | null }> {
  if (args.environmentId !== null && typeof args.environmentId !== 'string') {
    throw new EnvironmentError('bad_request', 'environmentId must be an id or null')
  }
  const hasChat = args.conversationId !== undefined && args.conversationId !== null && args.conversationId !== ''
  const chat = hasChat ? await loadOwnChat(svc, args.userId, args.conversationId) : null
  const workspaceId = chat?.workspace_id ?? args.workspaceId

  if (args.environmentId === null || args.environmentId === '') {
    if (!chat) throw new EnvironmentError('bad_request', 'conversationId is required to clear a chat’s environment')
    const { error } = await svc.from('chat_conversations').update({ environment_id: null }).eq('id', chat.id).eq('user_id', args.userId)
    if (error) throw new Error(`chat environment clear failed: ${error.message}`)
    return { environmentId: null }
  }

  const row = await loadEnvironmentRow(svc, args.environmentId)
  const role = row?.kind === 'cloud' ? await memberRole(svc, args.userId, workspaceId) : null
  // Someone else's Mac, or a cloud environment of another workspace or that
  // this person can't see, reads as missing.
  const visible =
    !!row &&
    (row.kind === 'mac'
      ? row.owner_user_id === args.userId
      : row.workspace_id === workspaceId && !!role && (role === 'owner' || role === 'admin' || row.shared === true || row.created_by === args.userId))
  if (!row || !visible) throw new EnvironmentError('not_found', 'Environment not found')
  if (!usableBy(row, args.userId, workspaceId, false)) throw new EnvironmentError('bad_request', 'You can’t use this environment here')

  if (chat) {
    const { error } = await svc.from('chat_conversations').update({ environment_id: row.id }).eq('id', chat.id).eq('user_id', args.userId)
    // 42501: migration 420's environment_check_chat_ref (archived or unshared since the read above).
    if (error?.code === '42501') throw new EnvironmentError('bad_request', 'You can’t use this environment here')
    if (error) throw new Error(`chat environment write failed: ${error.message}`)
  }
  await setDefault(svc, { userId: args.userId, workspaceId, environmentId: row.id })
  return { environmentId: row.id }
}
