/**
 * The owner's log of who talks to their agent (guest access, PR3): every
 * guest's text leaves one `data-guest-activity` part in the owner's home
 * thread per guest per hour, grown in place as the conversation goes on
 * (count, last time, a line of what they said). The chat draws it as a
 * compact line that opens the guest's conversation (PR4's card, over
 * GET /api/account/agent-guests/[guestId]/conversation).
 *
 * Best-effort: a guest's text is never refused or delayed for its log line.
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage, resolveHomeConversation } from '@/lib/chat/home-message-writer'
import { requestRoute } from '@/lib/reach/route'
import { GUEST_REQUEST_MESSAGE_KIND } from './chat-parts'
import type { GuestChannel } from './reach-owner'
import type { AgentGuest } from './store'

/** The part's type and the home message's metadata kind (PR4's GUEST_ACTIVITY_PART_TYPE / GUEST_ACTIVITY_MESSAGE_KIND). */
export const GUEST_ACTIVITY_PART = 'data-guest-activity' as const
export const GUEST_ACTIVITY_KIND = 'guest_activity' as const

const HOUR_MS = 60 * 60_000
const SUMMARY_MAX = 140

/**
 * Who a guest part is about (PR4's GuestRef, src/lib/guests/chat-parts.ts):
 * enough to say it and to open their conversation on one message.
 */
export interface GuestPartRef {
  id: string
  name: string
  preset: AgentGuest['preset']
  channel: GuestChannel
  conversation_id: string
  message_id?: string
}

/** What one log line carries (PR4's GuestActivityPartData). */
export interface GuestActivityData {
  guest: GuestPartRef
  /** What happened, in a line: what they said last. */
  summary: string
  /** Their texts in this stretch. */
  count: number
  started_at: string
  last_at: string
}

/** One line per guest per clock hour: its home message id. */
export function guestActivityMessageId(guestId: string, at: number): string {
  return `guest-activity:${guestId}:${Math.floor(at / HOUR_MS)}`
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= SUMMARY_MAX ? one : `${one.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
}

/** The line after one more text: a new stretch, or the stretch so far grown by one. Pure. */
export function nextGuestActivity(
  previous: GuestActivityData | null,
  input: { guest: Pick<AgentGuest, 'id' | 'displayName' | 'preset'>; conversationId: string; messageId: string; text: string; at: number; channel?: GuestChannel },
): GuestActivityData {
  const channel = input.channel ?? 'sms'
  const at = new Date(input.at).toISOString()
  return {
    guest: {
      id: input.guest.id,
      name: input.guest.displayName,
      preset: input.guest.preset,
      channel,
      conversation_id: input.conversationId,
      // The card opens on the stretch's first text.
      message_id: previous?.guest.message_id ?? input.messageId,
    },
    summary: `${channel === 'slack' ? 'On Slack' : 'Texted'}: “${clip(input.text)}”`,
    count: (previous?.count ?? 0) + 1,
    started_at: previous?.started_at ?? at,
    last_at: at,
  }
}

function activityOf(uiMessage: unknown): GuestActivityData | null {
  const parts = (uiMessage as { parts?: unknown } | null)?.parts
  if (!Array.isArray(parts)) return null
  const part = parts.find((p) => (p as { type?: unknown })?.type === GUEST_ACTIVITY_PART) as { data?: unknown } | undefined
  const data = part?.data as Partial<GuestActivityData> | undefined
  return data && typeof data.count === 'number' && typeof data.started_at === 'string' && data.guest && typeof data.guest === 'object' ? (data as GuestActivityData) : null
}

/** Log one guest text in the owner's home thread (see the header). Never throws. */
export async function recordGuestActivity(
  supabase: SupabaseClient,
  input: { guest: Pick<AgentGuest, 'id' | 'displayName' | 'preset' | 'ownerUserId' | 'workspaceId'>; conversationId: string; messageId: string; text: string; channel?: GuestChannel },
  now: number = Date.now(),
): Promise<void> {
  try {
    const owner = { userId: input.guest.ownerUserId, workspaceId: input.guest.workspaceId }
    const home = await resolveHomeConversation(supabase, owner)
    if (!home) return
    const id = guestActivityMessageId(input.guest.id, now)
    const { data: existing, error } = await supabase
      .from('chat_messages')
      .select('id, ui_message')
      .eq('conversation_id', home.conversationId)
      .eq('ui_message_id', id)
      .maybeSingle<{ id: string; ui_message: Record<string, unknown> | null }>()
    if (error) return
    const data = nextGuestActivity(existing ? activityOf(existing.ui_message) : null, { ...input, at: now })
    const parts = [{ type: GUEST_ACTIVITY_PART, id, data }]
    if (existing) {
      await supabase
        .from('chat_messages')
        .update({ ui_message: { ...(existing.ui_message ?? {}), parts } })
        .eq('id', existing.id)
      return
    }
    await appendHomeMessage(supabase, { ...owner, messageId: id, parts, metadata: { kind: GUEST_ACTIVITY_KIND, guest_id: input.guest.id } })
  } catch (err) {
    console.warn('[guest-activity] not logged:', err instanceof Error ? err.message : String(err))
  }
}

/** The access-request card's part type (PR4's GUEST_REQUEST_PART_TYPE). */
export const GUEST_REQUEST_PART = 'data-guest-request' as const
export const GUEST_REQUEST_KIND = GUEST_REQUEST_MESSAGE_KIND

/**
 * Someone texted "JOIN <code>": the owner's card in their home thread to
 * allow them with a preset or ignore them (PR5's routes). Only the last four
 * digits of their number. Keyed on the request, so it is written once. The
 * router (src/lib/reach/route.ts) then takes it to the owner where they are.
 * Never throws.
 */
export async function postGuestRequest(
  supabase: SupabaseClient,
  guest: Pick<AgentGuest, 'id' | 'displayName' | 'phone' | 'ownerUserId' | 'workspaceId' | 'requestedAt'>,
  now: number = Date.now(),
  deps: { route?: typeof requestRoute } = {},
): Promise<void> {
  try {
    const id = `guest-request:${guest.id}`
    const last4 = (guest.phone ?? '').replace(/[^0-9]/g, '').slice(-4)
    const data = {
      guest_id: guest.id,
      guest_name: guest.displayName,
      ...(last4.length === 4 ? { phone_last4: last4 } : {}),
      status: 'pending' as const,
      requested_at: guest.requestedAt ?? new Date(now).toISOString(),
    }
    const written = await appendHomeMessage(supabase, {
      userId: guest.ownerUserId,
      workspaceId: guest.workspaceId,
      messageId: id,
      parts: [{ type: GUEST_REQUEST_PART, id, data }],
      metadata: { kind: GUEST_REQUEST_KIND, guest_id: guest.id },
    })
    // Ids only, keyed on the request: a retried JOIN routes once.
    if (written.written && written.conversationId) {
      await (deps.route ?? requestRoute)({ userId: guest.ownerUserId, workspaceId: guest.workspaceId, conversationId: written.conversationId }, `guest-request:${guest.id}`)
    }
  } catch (err) {
    console.warn('[guest-request] card not posted:', err instanceof Error ? err.message : String(err))
  }
}
