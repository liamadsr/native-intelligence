/**
 * The conversation's stable system prompt, as the main chat and the plain
 * helper build it (../../../instructions/persona.ts), with ONE change: its
 * opening identity line names the model this helper runs on (DeepSeek V4 Flash with thinking on),
 * not the thread's (lib/helper-models.ts helperPersonaFor). Prompt caches are
 * per model anyway, so the different first line costs nothing.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchChatSpec, runTokenFromAuth, turnCtxFromAuth } from '../../../lib/spec-client.js'
import { helperPersonaFor } from '../../../lib/helper-models.js'

const persona = helperPersonaFor('flash-thinking')

export default defineDynamic({
  events: {
    'turn.started': async (_event, ctx) => {
      const spec = await fetchChatSpec(runTokenFromAuth(ctx.session.auth), turnCtxFromAuth(ctx.session.auth), { skills: true, turnContext: true })
      return defineInstructions({ content: await persona(spec) })
    },
  },
})
