/**
 * A clear drops the whole history, so the next turn starts with only the core
 * tools and no expertise pack counts as loaded (../lib/context-reset.ts, which
 * also resets after a summary, at ../instructions/context-reset.ts). Never
 * throws: a hook throw must not break the turn.
 */
import { defineHook } from 'eve/hooks'
import { markClear } from '../lib/context-reset.js'

export default defineHook({
  events: {
    async 'context.cleared'() {
      markClear()
    },
  },
})
