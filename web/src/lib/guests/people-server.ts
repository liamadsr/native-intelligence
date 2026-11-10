/**
 * The owner's People routes (/api/account/agent-guests): a stored guest as
 * the tab sees it, a fresh invite as it's shown once, and each store refusal
 * as the error the tab shows.
 *
 * Server only.
 */
import { apiError, badRequest, conflict, notFound, serverError } from '@/lib/api-errors'
import { twilioPhoneNumber } from '@/lib/twilio/config'
import { maskGuestPhone, type GuestInvite, type GuestView } from './people'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveHomeConversation } from '@/lib/chat/home-message-writer'
import { GUEST_REQUEST_PART } from './activity'
import { inviteText, unboundChannels, type AgentGuest } from './store'

export function toGuestView(guest: AgentGuest): GuestView {
  return {
    id: guest.id,
    displayName: guest.displayName,
    masked: guest.phone ? maskGuestPhone(guest.phone) : null,
    channels: guest.channels,
    peerUserId: guest.peerUserId,
    unbound: unboundChannels(guest),
    preset: guest.preset,
    tools: guest.tools,
    askTools: guest.askTools,
    askBefore: guest.askBefore,
    notes: guest.notes,
    calendarEmails: guest.calendarEmails ?? [],
    state: guest.state,
    inviteExpiresAt: guest.inviteExpiresAt,
    requestedAt: guest.requestedAt,
    activatedAt: guest.activatedAt,
    lastInboundAt: guest.lastInboundAt,
    optedOut: guest.optedOut,
    createdAt: guest.createdAt,
  }
}

export function toInvite(guest: AgentGuest, code: string): GuestInvite {
  return { code, text: inviteText(guest.displayName, code), niNumber: twilioPhoneNumber(), expiresAt: guest.inviteExpiresAt }
}

/** A store refusal as the tab's error. */
export function guestRefusal(reason: string): Response {
  switch (reason) {
    case 'bad_name':
      return badRequest('Give them a name (up to 80 characters).')
    case 'bad_channels':
      return badRequest('Pick at least one way for them to reach your agent: Text or Slack.')
    case 'bad_phone':
      return badRequest('Enter their mobile number, like (555) 123-4567. Text needs one.')
    case 'bad_calendar_emails':
      return badRequest('Enter up to 5 email addresses, like jess@example.com, separated by commas.')
    case 'unsupported_country':
      return badRequest('Native Intelligence can text US and Canadian mobile numbers only for now.')
    case 'own_number':
      return badRequest('That’s your own number.')
    case 'someones_number':
      return conflict('That number already reaches a Native Intelligence agent, so it can’t reach yours too.', undefined, 'GUEST_NUMBER_TAKEN')
    case 'already_listed':
      return conflict('That number is already on your list.', undefined, 'GUEST_ALREADY_LISTED')
    case 'too_many':
      return conflict('You can have up to 25 people. Remove someone first.', undefined, 'GUEST_LIMIT')
    case 'not_found':
      return notFound('That person isn’t on your list.')
    case 'wrong_state':
      return conflict('That changed in the meantime. Reopen People and try again.', undefined, 'GUEST_WRONG_STATE')
    case 'not_configured':
      return apiError('Guest access isn’t set up here yet.', { status: 503, code: 'GUESTS_NOT_CONFIGURED' })
    default:
      return serverError('Couldn’t save that. Try again.')
  }
}

/**
 * The access request's card in the owner's home thread (activity.ts
 * postGuestRequest), settled where it was answered here: approved with the
 * preset, or ignored, so the chat shows it settled too. Best-effort: a card
 * that isn't there (an older request) is left alone. Never throws.
 */
export async function settleGuestRequestCard(
  supabase: SupabaseClient,
  guest: Pick<AgentGuest, 'id' | 'ownerUserId' | 'workspaceId'>,
  outcome: { status: 'approved'; preset: string } | { status: 'ignored' },
  now: number = Date.now(),
): Promise<void> {
  try {
    const home = await resolveHomeConversation(supabase, { userId: guest.ownerUserId, workspaceId: guest.workspaceId })
    if (!home) return
    const id = `guest-request:${guest.id}`
    const { data: existing, error } = await supabase
      .from('chat_messages')
      .select('id, ui_message')
      .eq('conversation_id', home.conversationId)
      .eq('ui_message_id', id)
      .maybeSingle<{ id: string; ui_message: { parts?: Array<{ type?: string; data?: Record<string, unknown> }> } | null }>()
    if (error || !existing) return
    const parts = (existing.ui_message?.parts ?? []).map((part) =>
      part.type === GUEST_REQUEST_PART ? { ...part, data: { ...(part.data ?? {}), ...outcome, settled_at: new Date(now).toISOString() } } : part,
    )
    await supabase
      .from('chat_messages')
      .update({ ui_message: { ...(existing.ui_message ?? {}), parts } })
      .eq('id', existing.id)
  } catch (err) {
    console.warn('[guest-request] card not settled:', err instanceof Error ? err.message : String(err))
  }
}
