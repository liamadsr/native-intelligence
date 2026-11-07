/**
 * The conversation's stable system prompt, as the main chat builds it
 * (../../../instructions/persona.ts), with ONE change: its opening identity
 * line names the model this helper runs on (DeepSeek V4 Flash), not the
 * thread's (Haiku 5.5: lib/helper-models.ts helperPersonaFor). The rest of the
 * prefix matches the parent's, and prompt caches are per model anyway. The
 * helper's role rides its task message (../../../lib/helpers.ts), never
 * extra system text. On the person's ChatGPT plan the prompt is unchanged.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchChatSpec, runTokenFromAuth, turnCtxFromAuth } from '../../../lib/spec-client.js'
import { helperPersonaFor } from '../../../lib/helper-models.js'

const persona = helperPersonaFor('flash')

export default defineDynamic({
  events: {
    'turn.started': async (_event, ctx) => {
      const spec = await fetchChatSpec(runTokenFromAuth(ctx.session.auth), turnCtxFromAuth(ctx.session.auth), { skills: true, turnContext: true })
      return defineInstructions({ content: await persona(spec) })
    },
  },
})
