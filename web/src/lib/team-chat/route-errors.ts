/**
 * Team chat's routes' error answers: a {@link TeamChatError} as its status,
 * anything else as a 500 (logged with no words of a message).
 */
import { badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import { TeamChatError } from './store'

export function teamChatErrorResponse(err: unknown, where: string): Response {
  if (err instanceof TeamChatError) {
    switch (err.code) {
      case 'not_found':
        return notFound()
      case 'forbidden':
        return forbidden()
      case 'conflict':
        return conflict('A channel with that name already exists')
      case 'bad_request':
        return badRequest()
      default:
        break
    }
  }
  console.error(`[team-chat] ${where} failed:`, err instanceof Error ? err.message : 'unknown')
  return serverError()
}

