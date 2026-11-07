/**
 * The compliance keywords (CTIA / US carriers), read before anything else an
 * inbound text could mean: a whole message that is one of them, in any case,
 * with trailing punctuation or spaces ignored, and spaces or hyphens inside it
 * too ("OPT OUT", "opt-out"). "Stop the meeting" is a message for the agent;
 * "STOP" or "stop." is an opt-out.
 *
 * YES is Twilio's third re-subscribe keyword (with START and UNSTOP), but a
 * person answering the agent's question with "yes" must reach the agent. So
 * it classifies as 'yes', and the inbound handler treats it as START only
 * for a number that is opted out (what Twilio itself then does), and as an
 * ordinary message otherwise.
 */

export const STOP_KEYWORDS: ReadonlySet<string> = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'])
export const START_KEYWORDS: ReadonlySet<string> = new Set(['START', 'UNSTOP'])
export const HELP_KEYWORDS: ReadonlySet<string> = new Set(['HELP', 'INFO'])

export type SmsKeyword = 'stop' | 'start' | 'help' | 'yes'

/** The keyword a whole message is, or null for an ordinary message. */
export function classifySmsKeyword(body: unknown): SmsKeyword | null {
  if (typeof body !== 'string') return null
  const word = body.trim().replace(/[\s.!?,;:'"]+$/g, '').replace(/^[\s'"]+/, '').replace(/[\s-]+/g, '').toUpperCase()
  if (!word || word.length > 16) return null
  if (STOP_KEYWORDS.has(word)) return 'stop'
  if (START_KEYWORDS.has(word)) return 'start'
  if (HELP_KEYWORDS.has(word)) return 'help'
  if (word === 'YES') return 'yes'
  return null
}
