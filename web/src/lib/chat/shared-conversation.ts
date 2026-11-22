/**
 * Opening an agent chat read-only (docs/plans/mentions-everywhere.md, JOB 2):
 * the pure half of GET /api/account/conversations/[id]/shared. The route does
 * the IO (auth, the service-client reads); this file decides who may read and
 * shapes the rows, so both are unit-testable without a database.
 *
 * ACCESS (decideSharedAccess): a chat with the agent is its owner's alone
 * (chat_conversations RLS stays owner-only — the reader never touches it). The
 * caller may read it when they are its owner, OR when a `conversation_share`
 * row (migration 671) names them as grantee in the SAME workspace as the
 * conversation. Anything else is null, which the route answers as 404 (never
 * 403: a grantee must not be told a chat exists).
 *
 * SHAPING (shapeSharedMessages): a reader sees only each message's role and its
 * plain text, oldest first, capped. Tool calls, tool results, reasoning, file
 * and data parts, and all metadata are dropped — only `text` parts survive. The
 * kinds the owner's own thread hides are hidden here too: a reaction's own turn
 * (metadata.kind 'reaction'), a message from an outside channel (Slack, SMS, a
 * call: isChannelMessageRow), and a card the person opened from `/`
 * (isOpenedCardMessage). A message with no text left is dropped.
 */
import { isChannelMessageRow } from '@/lib/chat/channel-turn'
import { REACTION_TURN_KIND } from '@/lib/chat/message-reactions'
import { isOpenedCardMessage } from '@/lib/chat-cards/opened-card'

/** Who the caller is to a conversation, or null (no access → the route's 404). */
export type SharedConversationRole = 'owner' | 'grantee'

/** The conversation row the access decision reads (service client). */
export interface SharedConversationRow {
  id: string
  user_id: string
  workspace_id: string
  title: string | null
}

/** A `conversation_share` row (migration 671), as far as the decision cares. */
export interface ConversationShareRow {
  conversation_id: string
  grantee_member_id: string
  workspace_id: string
}

/**
 * The caller's access to `conversation`, or null when they have none. The
 * conversation must live in the workspace the caller is acting in
 * (`workspaceId`, from requireWorkspaceMember). The caller is the owner when
 * its `user_id` is theirs; a grantee when a share names their member id in that
 * same workspace. Everything else is null.
 */
export function decideSharedAccess(args: {
  conversation: SharedConversationRow | null
  callerUserId: string
  workspaceId: string
  /** The caller's member id(s) in the conversation's workspace (requireWorkspaceMember's `member.id`). */
  callerMemberIds: readonly string[]
  shares: readonly ConversationShareRow[]
}): SharedConversationRole | null {
  const { conversation, callerUserId, workspaceId, callerMemberIds, shares } = args
  if (!conversation) return null
  // Only ever a conversation in the workspace the caller is acting in: a chat
  // of another workspace is 404, never reachable from here.
  if (conversation.workspace_id !== workspaceId) return null
  if (conversation.user_id === callerUserId) return 'owner'
  const members = new Set(callerMemberIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  if (members.size === 0) return null
  const shared = shares.some(
    (s) =>
      s.conversation_id === conversation.id &&
      s.workspace_id === conversation.workspace_id &&
      members.has(s.grantee_member_id),
  )
  return shared ? 'grantee' : null
}

/** One message as a reader sees it: role, plain text, and when it was said. */
export interface SharedMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string | null
}

/** A `chat_messages` row the shaper reads (service client). */
export interface SharedMessageRow {
  ui_message: unknown
  created_at?: string | null
}

/** The most recent messages a reader is shown (older ones are dropped). */
export const SHARED_CONVERSATION_MESSAGE_CAP = 200

interface StoredUiMessage {
  id?: unknown
  role?: unknown
  parts?: unknown
  metadata?: { kind?: unknown } | null
}

/** A message's plain `text` parts joined; '' when it has none (tool/file/reasoning parts are dropped). */
function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  const out: string[] = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const part = p as { type?: unknown; text?: unknown }
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) out.push(part.text.trim())
  }
  return out.join('\n')
}

/**
 * True for a stored message the owner's own thread hides, so the shared view
 * hides it too: a reaction's own turn, a message from an outside channel, or a
 * card opened from `/`.
 */
function isHiddenKind(ui: StoredUiMessage): boolean {
  if (ui.metadata && typeof ui.metadata === 'object' && ui.metadata.kind === REACTION_TURN_KIND) return true
  if (isChannelMessageRow(ui)) return true
  if (Array.isArray(ui.parts) && isOpenedCardMessage({ parts: ui.parts as never })) return true
  return false
}

/**
 * The rows (oldest first) shaped for a reader: role + plain text + created_at,
 * hidden kinds and text-less messages dropped, capped to the most recent
 * SHARED_CONVERSATION_MESSAGE_CAP.
 */
export function shapeSharedMessages(rows: readonly SharedMessageRow[]): SharedMessage[] {
  const shaped: SharedMessage[] = []
  for (const row of rows) {
    const ui = (row.ui_message ?? null) as StoredUiMessage | null
    if (!ui || typeof ui !== 'object') continue
    const role = ui.role === 'user' ? 'user' : ui.role === 'assistant' ? 'assistant' : null
    if (!role) continue
    if (isHiddenKind(ui)) continue
    const text = textOf(ui.parts)
    if (!text) continue
    shaped.push({
      id: typeof ui.id === 'string' ? ui.id : '',
      role,
      text,
      createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    })
  }
  // Keep the newest cap, oldest first.
  return shaped.length > SHARED_CONVERSATION_MESSAGE_CAP ? shaped.slice(shaped.length - SHARED_CONVERSATION_MESSAGE_CAP) : shaped
}

/** What the route answers for a reader (owner or grantee). */
export interface SharedConversationPayload {
  id: string
  title: string | null
  /** 'owner' → "Your chat"; 'grantee' → "Shared by <ownerName>". */
  role: SharedConversationRole
  /** The owner's member display name, or null when it can't be read. */
  ownerName: string | null
  messages: SharedMessage[]
}
