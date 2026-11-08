/**
 * A link store refusal (./store.ts) as the People tab's error. Server only
 * (the routes'), but imports nothing server-only.
 */
import { apiError, badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import type { LinkRefusalReason } from './store'

export function linkRefusal(reason: LinkRefusalReason): Response {
  switch (reason) {
    case 'bad_name':
      return badRequest('Give them a name (up to 80 characters).')
    case 'bad_email':
      return badRequest('Enter the email they sign in to Native Intelligence with.')
    case 'bad_preset':
      return badRequest('Pick Household or Colleague.')
    case 'self':
      return badRequest('That’s you.')
    case 'not_member':
      return badRequest('They aren’t in this workspace. Ask them by email instead.')
    case 'already_linked':
      return conflict('You’ve already asked them, or your agents are already linked.', undefined, 'AGENT_LINK_EXISTS')
    case 'they_asked':
      return conflict('They’ve already asked to link with you. Accept their request in People.', undefined, 'AGENT_LINK_THEY_ASKED')
    case 'too_many_pending':
      return conflict('You have 5 requests waiting. Wait for an answer or withdraw one first.', undefined, 'AGENT_LINK_PENDING_LIMIT')
    case 'too_many':
      return conflict('You can have up to 25 people. Remove someone first.', undefined, 'GUEST_LIMIT')
    case 'outside_off':
      return forbidden('Your workspace’s admin has turned off links with agents outside it.')
    case 'not_found':
      return notFound('That request isn’t there any more.')
    case 'expired':
      return apiError('That request expired. Ask them to send a new one.', { status: 410, code: 'AGENT_LINK_EXPIRED' })
    case 'wrong_state':
      return conflict('That changed in the meantime. Reopen People and try again.', undefined, 'AGENT_LINK_WRONG_STATE')
    default:
      return serverError('Couldn’t save that. Try again.')
  }
}
