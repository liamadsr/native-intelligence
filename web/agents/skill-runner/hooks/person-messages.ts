/**
 * Keeps the person's own words in a loop run's follow-up chat
 * (lib/person-messages.ts), from eve's `message.received`, for the reviewer.
 * Only a chat token's delivery counts, never a relayed one. Never throws: a
 * hook throw must not break the turn.
 */
import { defineHook } from 'eve/hooks'
import { noteSkillChatMessage } from '../lib/person-messages.js'
import { runTokenFromAuth } from '../lib/spec-client.js'

export default defineHook({
  events: {
    async 'message.received'(event, ctx) {
      try {
        const auth = (ctx as { session?: { auth?: unknown } } | undefined)?.session?.auth
        if (!auth) return
        noteSkillChatMessage(event.data, runTokenFromAuth(auth as Parameters<typeof runTokenFromAuth>[0]))
      } catch {
        // Never break the turn.
      }
    },
  },
})
