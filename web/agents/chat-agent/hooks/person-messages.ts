/**
 * Keeps the person's latest messages in this session (lib/person-messages.ts),
 * from eve's `message.received`, so a `remember` with scope 'profile' can be
 * checked against what they actually said. A server-started turn's message
 * (a home turn's background update) is skipped: it is not the person's. A
 * channel turn's (a Slack message or a text from the person) is theirs, and kept.
 * Never throws: a hook throw must not break the turn.
 */
import { defineState } from 'eve/context'
import { defineHook } from 'eve/hooks'
import { notePersonMessage } from '../lib/person-messages.js'
import { relayFromRunToken, runTokenFromAuth, serverFromRunToken } from '../lib/spec-client.js'
import { isMacHost } from '../lib/host.js'
import { macPersonText } from '../lib/mac-host.js'

/**
 * True when nobody typed the delivery, so it never counts as the person's
 * words (the evidence for remember AND for the reviewer, action.review):
 *   - a token the server minted for itself (a home turn's background update,
 *     A4 slice 5), EXCEPT a channel turn (`server: 'channel_turn'`): a Slack
 *     DM from the person's linked Slack account, or a text from their verified
 *     phone, is their own words (docs/plans/slack-connect.md, decision 14);
 *   - a turn the main agent relayed into a bot's thread (the `relay` claim,
 *     bots v4 A4): the main agent's message on the person's behalf, which
 *     must not pass for the person's own ask.
 * Never throws; an unreadable auth is not skipped.
 */
export function isServerDelivery(ctx: unknown): boolean {
  try {
    const auth = (ctx as { session?: { auth?: unknown } } | undefined)?.session?.auth
    if (auth === undefined || auth === null) return false
    const token = runTokenFromAuth(auth as Parameters<typeof runTokenFromAuth>[0])
    const server = serverFromRunToken(token)
    return (server !== undefined && server !== 'channel_turn') || relayFromRunToken(token) !== undefined
  } catch {
    return false
  }
}

/**
 * The Mac body (lib/host.ts): whether this session's first message, the job's
 * request, has gone by. The request is the cloud body's wording and reaches
 * the Mac unprefixed, so whatever it starts with (an injected `[From Liam]`
 * included) is never the person's.
 */
const macRequestSeen = defineState<boolean>('chat-agent.mac-request-seen', () => false)

export default defineHook({
  events: {
    async 'message.received'(event, ctx) {
      if (isServerDelivery(ctx)) return
      if (isMacHost()) {
        // On the Mac only `[From <name>]` messages after the request are the
        // person's words (lib/mac-host.ts macPersonText); the request and the
        // cloud body's messages are the agent's.
        const data = (event.data ?? {}) as { kind?: unknown; message?: unknown }
        if (data.kind !== undefined) return
        if (!macRequestSeen.get()) {
          macRequestSeen.update(() => true)
          return
        }
        const text = typeof data.message === 'string' ? macPersonText(data.message) : null
        if (text !== null) notePersonMessage({ ...data, message: text })
        return
      }
      notePersonMessage(event.data)
    },
  },
})
