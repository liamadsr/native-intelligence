/**
 * At a turn's start, before its first model call resolves the tools: once the
 * history holds a new summary (or a clear came before), back to the core tools
 * and no packs loaded (../lib/context-reset.ts says why and when). Adds no
 * instructions: it only reads the history the turn starts from. Never throws.
 */
import { defineDynamic } from 'eve/instructions'
import { resetIfSummarized } from '../lib/context-reset.js'

export default defineDynamic({
  events: {
    'turn.started': async (_event, ctx) => {
      resetIfSummarized(ctx.messages)
      return null
    },
  },
})
