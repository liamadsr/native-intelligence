/**
 * /api/ai/chat — REMOVED. Every method answers 410 Gone.
 *
 * This was the cloud chat's in-process streamText route. eve is now the only
 * cloud chat runtime: the in-app panel mints a run token at
 * /api/account/chat/eve-session and talks to the chat-agent at
 * /eve/chat-agent/v1/*. The route's body is gone.
 *
 * The path answers 410 instead of falling through to Next's 404 HTML page
 * because one known client outside this repo still POSTs here: the dial8-app
 * macOS/iOS AIBackendService. It gets a parseable `{ error, code }` body it can
 * surface, rather than an HTML page its JSON decoder chokes on. This file is
 * not a compatibility layer: it runs no model, reads no session and touches no
 * data. Delete it once the dial8-app client has moved to the eve session flow.
 */
import { apiError } from '@/lib/api-errors'

const CHAT_ROUTE_REMOVED_CODE = 'CHAT_ROUTE_REMOVED'

function gone() {
  return apiError(
    'This chat endpoint has been removed. Update the app to use the current chat.',
    { status: 410, code: CHAT_ROUTE_REMOVED_CODE },
  )
}

export const GET = gone
export const POST = gone
export const PUT = gone
export const PATCH = gone
export const DELETE = gone
