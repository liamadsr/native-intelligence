/**
 * /api/account/chat/reactions — the person's emoji reaction on one of the
 * agent's messages in the main chat (src/lib/chat/message-reactions.ts). One
 * per bubble (a turn draws several around its tool steps: message-bubbles.ts),
 * kept on the message itself by the bubble's place
 * (`ui_message.metadata.reactions`, `{ "0": { emoji, at }, … }`), so they come
 * back with the thread on reload. Nothing else is written: the
 * agent hears it from the client, which sends the reactions since the
 * person's last message with their next turn (`systemContext.reactions`), or
 * starts a turn of its own for one that answers.
 *
 *   GET  ?conversationId=<uuid>
 *        → 200 { reactions: { [uiMessageId]: { [bubble]: { emoji, at } } } }: the newest
 *        REACTIONS_READ_MAX reacted replies of the caller's conversation. The
 *        chat reads it once per conversation (use-message-reactions.ts): a
 *        thread restored from the device's own copy predates a reaction made
 *        since, here or on another device.
 *   POST { conversationId, messageId, bubble, emoji: string | null }
 *        → 200 { reaction: { emoji, at } | null }. 400 bad input, or a
 *        message that isn't the agent's; 404 NOT_FOUND when the conversation
 *        is not the caller's or the message is not persisted yet (the client
 *        retries); 409 CONFLICT when the row kept changing under the write.
 *
 * `null` takes the reaction off. The emoji must be one (isReactionEmoji: a
 * single pictographic sequence, skin tone and all). The write is a
 * read-modify-write of `ui_message`: only that bubble's entry in
 * `metadata.reactions` changes (the key goes when its last one does), never
 * the message's parts or the rest of its metadata.
 *
 * The person proves themselves with their session (requireWorkspace), and
 * every read and write runs on that same RLS client: an assistant row carries
 * the conversation owner's user_id (eve-message-writer.ts persistEveMessage),
 * so the owner-scoped SELECT and UPDATE policies (migrations 012 and 176)
 * already let the person change only their own conversation's rows. The
 * conversation is checked first anyway, so another workspace's thread (or a
 * teammate's) is a 404 rather than a silent no-op.
 *
 * A reply the server's backup wrote first (a provisional row,
 * eve-message-writer.ts) is replaced whole by the browser's copy moments
 * later. So the write is fenced on the provisional mark it read: a row that
 * stopped being provisional since is read again and written once more, never
 * written back over the final copy.
 */
import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, conflict, notFound, serverError } from '@/lib/api-errors'
import { isReactionEmoji, parseMessageReactions, REACTION_METADATA_KEY, type MessageReaction } from '@/lib/chat/message-reactions'
import { MAX_MESSAGE_BUBBLES } from '@/lib/chat/message-bubbles'
import { EVE_PROVISIONAL_METADATA_KEY } from '@/lib/chat/eve-message-writer'

export const dynamic = 'force-dynamic'

/** A UIMessage id: what chat_messages.ui_message_id holds (the feedback route's rule). */
const MESSAGE_ID_RE = /^[A-Za-z0-9_\-:.]{1,200}$/

const BodySchema = z.object({
  conversationId: z.string().uuid('conversationId must be a uuid'),
  messageId: z.string().regex(MESSAGE_ID_RE, 'messageId is not a message id'),
  bubble: z.number().int().min(0).max(MAX_MESSAGE_BUBBLES - 1),
  emoji: z.union([z.string().refine(isReactionEmoji, 'emoji must be one emoji'), z.null()]),
})

/** The jsonb path of the reply backup's provisional mark. */
const PROVISIONAL_PATH = `ui_message->metadata->>${EVE_PROVISIONAL_METADATA_KEY}`

/** How many times the write reads the row again when it changed under it. */
const ATTEMPTS = 2

/** The most reacted replies a GET returns (the newest). */
export const REACTIONS_READ_MAX = 500

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The reactions, read as their JSON text off the row (never the whole ui_message). */
const REACTIONS_PATH = `ui_message->metadata->>${REACTION_METADATA_KEY}`

type UiMessage = { metadata?: unknown } & Record<string, unknown>

/** `ui_message` with one bubble's reaction set, or taken off for null; everything else as it was. */
function withReaction(ui: UiMessage, bubble: number, reaction: MessageReaction | null): UiMessage {
  const metadata = ui.metadata && typeof ui.metadata === 'object' && !Array.isArray(ui.metadata) ? { ...(ui.metadata as Record<string, unknown>) } : {}
  const reactions: Record<string, MessageReaction> = Object.fromEntries([...parseMessageReactions(metadata[REACTION_METADATA_KEY])].map(([b, r]) => [String(b), r]))
  if (reaction) reactions[String(bubble)] = reaction
  else delete reactions[String(bubble)]
  if (Object.keys(reactions).length > 0) metadata[REACTION_METADATA_KEY] = reactions
  else delete metadata[REACTION_METADATA_KEY]
  return { ...ui, metadata }
}

/** Whether the conversation is the caller's, in this workspace. */
async function ownsConversation(supabase: SupabaseClient, conversationId: string, userId: string, workspaceId: string): Promise<boolean | 'error'> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) return 'error'
  return !!data
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const conversationId = new URL(request.url).searchParams.get('conversationId') ?? ''
  if (!UUID_RE.test(conversationId)) return badRequest('conversationId must be a uuid')
  const owns = await ownsConversation(supabase, conversationId, user.id, workspaceId)
  if (owns === 'error') return serverError()
  if (!owns) return notFound('Conversation not found')

  const { data, error } = await supabase
    .from('chat_messages')
    .select(`ui_message_id, reactions:${REACTIONS_PATH}`)
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .not(REACTIONS_PATH, 'is', null)
    .order('created_at', { ascending: false })
    .limit(REACTIONS_READ_MAX)
  if (error) return serverError()

  const reactions: Record<string, Record<string, MessageReaction>> = {}
  for (const row of (data ?? []) as Array<{ ui_message_id: string | null; reactions: unknown }>) {
    let value: unknown = row.reactions
    // `->>` reads the object as its JSON text.
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        value = null
      }
    }
    const byBubble = parseMessageReactions(value)
    if (row.ui_message_id && byBubble.size > 0) reactions[row.ui_message_id] = Object.fromEntries([...byBubble].map(([b, r]) => [String(b), r]))
  }
  return NextResponse.json({ reactions })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('Invalid JSON')
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Bad request')
  const body = parsed.data

  const owns = await ownsConversation(supabase, body.conversationId, user.id, workspaceId)
  if (owns === 'error') return serverError()
  if (!owns) return notFound('Conversation not found')

  const reaction: MessageReaction | null = body.emoji ? { emoji: body.emoji, at: new Date().toISOString() } : null

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { data: row, error: readError } = await supabase
      .from('chat_messages')
      .select('id, role, ui_message')
      .eq('conversation_id', body.conversationId)
      .eq('ui_message_id', body.messageId)
      .maybeSingle()
    if (readError) return serverError()
    const message = row as { id: string; role: string; ui_message: UiMessage | null } | null
    if (!message?.ui_message) return notFound('Message not found')
    if (message.role !== 'assistant') return badRequest('Only the agent’s messages take a reaction')

    const provisional = (message.ui_message.metadata as Record<string, unknown> | undefined)?.[EVE_PROVISIONAL_METADATA_KEY] === true
    const update = supabase.from('chat_messages').update({ ui_message: withReaction(message.ui_message, body.bubble, reaction) }).eq('id', message.id)
    const fenced = provisional ? update.eq(PROVISIONAL_PATH, 'true') : update.is(PROVISIONAL_PATH, null)
    const { data: written, error: writeError } = await fenced.select('id')
    if (writeError) return serverError('Could not save the reaction')
    if (Array.isArray(written) && written.length > 0) return NextResponse.json({ reaction })
  }
  return conflict('The message changed while the reaction was saved; try again.')
}
