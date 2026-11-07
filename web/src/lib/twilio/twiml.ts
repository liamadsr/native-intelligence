/**
 * The webhook's answer: TwiML. Empty (`<Response/>`) when nothing is said
 * back inline (an ordinary text: the reply comes later, from the turn), or one
 * `<Message>` for an immediate answer (HELP, START, an unknown sender).
 */

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** TwiML for `message`, or the empty response when there is none. */
export function twimlBody(message?: string | null): string {
  const head = '<?xml version="1.0" encoding="UTF-8"?>'
  return message ? `${head}<Response><Message>${escapeXml(message)}</Message></Response>` : `${head}<Response/>`
}

/** A TwiML HTTP response (200, text/xml). */
export function twimlResponse(message?: string | null): Response {
  return new Response(twimlBody(message), { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } })
}
