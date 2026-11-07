/**
 * Turn-scoped instructions for a FOLLOW-UP CHAT turn on a parked skill-run
 * session (bots v3 Phase 4, docs/plans/bots-v3.md "the exact chat for loop
 * runs").
 *
 * A loop's run parks its session when it finishes, and the loop's bot can then
 * carry on that exact chat with the person. Each chat turn arrives under a
 * fresh run token whose spec carries `chatTurn.instructions` (written
 * server-side, src/lib/flows/skill-run-chat-ceiling.ts): the run is over,
 * someone is here, answer in prose. The session's own system prompt (persona.ts,
 * session-scoped, with the headless contract) stays as it was; this turn-scoped
 * system text sits on top of it for the turn only ("every turn starts with
 * fresh turn-scoped system instructions", eve docs, dynamic-capabilities).
 *
 * A run's own turn carries no chat claim on its token, so this fetches
 * nothing and contributes nothing there (null). A chat turn whose spec can't
 * be fetched contributes nothing too.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchEveSpec, isChatRunToken, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'turn.started': async (_event, ctx) => {
      const runToken = runTokenFromAuth(ctx.session.auth)
      // A run's own turn is no chat turn: no spec fetch at all.
      if (!isChatRunToken(runToken)) return null
      const spec = await fetchEveSpec(runToken)
      const text = spec?.chatTurn?.instructions
      if (typeof text !== 'string' || !text.trim()) return null
      return defineInstructions({ markdown: text })
    },
  },
})
