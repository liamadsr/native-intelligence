/**
 * Dynamic instructions for the chat-agent (Phase 4).
 *
 * The conversation's REAL system prompt is rebuilt server-side by the SAME
 * buildChatSystemPrompt the cloud route used, and fetched over the internal
 * spec route. Returning it as `defineInstructions` gives it genuine
 * SYSTEM-PROMPT semantics (the invariant: same prompts as system prompts, NOT
 * degraded into user text). The generic static contract in ../instructions.md
 * stays; this per-conversation prompt layers on top.
 *
 * Since chat-ttft P3 the spec's system prompt holds only what stays the same
 * from turn to turn: the model identity line, the base prompt, web access, the
 * agent and skill, the connected MCP servers, the workspace brief, the user's
 * profile and the skills list. The per-turn layers (the view, the CONTEXT
 * SWITCH notice, editor selection, chat files, live capture, mentions, the mail
 * thread, the clock) ride `spec.turnContext` and reach the model as a
 * user-role message from ./turn-context.ts. From an app that predates the
 * split, the system prompt still carries them all.
 *
 * ── Resolves once per TURN (turn.started) — parity with the cloud route ─────
 * The cloud route rebuilt this prompt on every POST — i.e. every turn — so the
 * agent, skill, brief, profile and skills were always current. The original eve
 * port resolved on `session.started` instead, which fires ONCE for the life of
 * the durable session: the ctx kept arriving fresh each turn (the transport
 * re-encodes it on every send), but the resolver that consumes it never re-ran,
 * so mid-conversation navigation NEVER reached the model (verified regression,
 * 2026-07-14 parity audit). `turn.started` restores the per-POST semantics.
 *
 * Prompt-cache note: when nothing stable changed, the rebuilt prompt is
 * byte-identical turn to turn, so the provider's prefix cache holds (the
 * per-turn layers no longer sit in it). A change to a stable layer (a
 * recompiled brief, a new skill) invalidates from that layer on, once.
 *
 * ── Failure semantics: a throw and a null are the same here ─────────────────
 * eve 0.66.3 starts every turn with fresh turn-scoped system instructions:
 * dispatchDynamicInstructionEvent resets the turn slot on `turn.started` before
 * it runs the resolvers (dist/src/context/dynamic-instruction-lifecycle.js), so
 * neither a throw nor a null keeps the previous turn's prompt. On a failed
 * spec fetch this turn runs with the static ../instructions.md alone. The
 * resolver throws rather than returning null only so eve logs the skipped
 * resolver ("Dynamic instructions resolver (turn.started) threw — skipping.").
 *
 * ── The Mac body (contract C2, ../lib/host.ts) ──────────────────────────────
 * The spec comes from C1 for the session's conversation, and the Mac body's
 * own instructions follow it (../lib/mac-instructions.ts: the folder, the
 * mode, who its messages are from, how it talks back). Without a spec (a dev
 * launch has no session token, or the route failed) it still gets those: they
 * are what makes it a worker in the folder at all.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchChatSpec, runTokenFromAuth, turnCtxFromAuth } from '../lib/spec-client.js'
import { isMacHost } from '../lib/host.js'
import { macHostInstructions } from '../lib/mac-instructions.js'
import { recordPromptSize } from '../lib/context-parts.js'

export default defineDynamic({
  events: {
    'turn.started': async (event, ctx) => {
      const turnId = turnIdOf(event)
      const runToken = runTokenFromAuth(ctx.session.auth)
      const turnCtx = turnCtxFromAuth(ctx.session.auth)
      // { skills: true } → the systemPrompt arrives with the "Available skills"
      // section appended (descriptions only; bodies load on demand via the
      // native load_skill tool). Turn-fresh like the rest of the prompt: a
      // skill created mid-conversation is advertised on the NEXT turn.
      // { turnContext: true } → the stable prompt; the per-turn layers go out
      // through ./turn-context.ts.
      const spec = await fetchChatSpec(runToken, turnCtx, { skills: true, turnContext: true })
      if (isMacHost()) {
        const mac = macHostInstructions(process.env.LOCAL_AGENT_MODE, spec ? new Set(spec.ceilingTools.map((t) => t.name)) : undefined)
        const content = spec?.systemPrompt ? `${spec.systemPrompt}\n\n${mac}` : mac
        recordPromptSize(turnId, content)
        return defineInstructions({ content })
      }
      if (!spec?.systemPrompt) {
        // Thrown only to be logged: this turn runs without the persona either way (see above).
        throw new Error('chat spec fetch failed — this turn runs without the conversation prompt')
      }
      // What the prompt cost this turn, for the side panel's Context card (lib/context-parts.ts).
      recordPromptSize(turnId, spec.systemPrompt)
      return defineInstructions({ content: spec.systemPrompt })
    },
  },
})

/** The turn id a turn.started event carries (`data.turnId`), or null. */
function turnIdOf(event: unknown): string | null {
  const id = (event as { data?: { turnId?: unknown } } | null)?.data?.turnId
  return typeof id === 'string' && id ? id : null
}
