/**
 * The helper's workspace tools: the main chat's resolver
 * (../../../tools/workspace_tools.ts) in the `helper` role. The surface is the
 * spec's `helperToolNames` (read plus drafts, no cards, browser, memory,
 * external writes or MCP: ../../../lib/helper-role.ts), so the core set,
 * `search_tools` discovery and `load_skill` all stay inside it, and every
 * proxy marks its call as a helper's so the internal tool route re-checks it
 * (src/lib/chat/helpers-gate.ts). Discovery state is this child session's own.
 */
import { defineDynamic } from 'eve/tools'
import { discoveredToolNames, resolveAdvertised } from '../../../tools/workspace_tools.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => resolveAdvertised(ctx.session.auth, [], ctx.messages, 'helper'),
    'step.started': async (_event, ctx) => resolveAdvertised(ctx.session.auth, discoveredToolNames(), ctx.messages, 'helper'),
  },
})
