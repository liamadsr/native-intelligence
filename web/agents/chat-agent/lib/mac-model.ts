/**
 * The Mac body's model (contract C2, docs/plans/teammate-agent.md), resolved
 * per model step. The model itself is the local agent's
 * (agents/local-agent/lib/model.ts, imported unchanged): the Dial8 model relay
 * with the session token, a model on the Mac when the desktop chose one (L4,
 * F-web), or the dev key.
 *
 * Per step, not static: eve compiles a static model's id and window from the
 * BUILD environment (the bundle build has no model variables, so the manifest
 * would say the Gateway's Sonnet at 250K whatever the Mac runs), and only
 * takes the live LanguageModel at runtime. A model on the Mac has its own,
 * much smaller context: what its server loaded it with, at least 32K. So the
 * window must come from probing that server, and eve accepts a live
 * LanguageModel only at step scope. One model per process: the launch
 * environment never changes, and a local model's fetch probes its server once.
 *
 * The window: lib/model.ts's `resolveLocalAgentContextWindow` (F-web's L4).
 * For the relay it is 250K, as the local agent's window was (left to the
 * catalog's 1M, eve would compact near 900K). For a model on the Mac it is
 * the context the probe read, awaited at the first step: the probe is the one
 * the model's first request shares, so even the first step compacts at the
 * real window, not the 32K floor. Read once per process, like the model.
 *
 * A failed probe never throws here: eve fails the whole session, for good, on
 * a throw from a model resolver (MODEL_SELECTION_FAILED), where the same
 * sentence from the model's request fails only the turn, and the person can
 * start their model server and try again. So the step takes the floor
 * (`localAgentContextWindow`), and the model's request probes again and fails
 * the turn with the probe's sentence. A Stop ends the wait for the probe (a
 * cold Ollama load can take minutes). All of it comes through ./mac-slots.ts,
 * a stub in the cloud build.
 */
import { defineDynamic } from 'eve'
import { createLocalAgentModel, localAgentContextWindow, localAgentPlanStep, resolveLocalAgentContextWindow } from './mac-slots.js'

let model: ReturnType<typeof createLocalAgentModel> | undefined
let window: number | undefined

/** The promise, or the signal's abort, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** This launch's window (see the file comment): after the probe, once; the floor while the probe fails. */
async function macContextWindow(signal: AbortSignal | undefined): Promise<number> {
  if (window !== undefined) return window
  try {
    return (window = await untilAborted(resolveLocalAgentContextWindow(), signal))
  } catch (err) {
    if (signal?.aborted) throw err
    return localAgentContextWindow()
  }
}

/**
 * The Mac body's `model` (agent.ts): this launch's model and its window, at
 * every model step. On the person's own ChatGPT plan (the free tier: the
 * relay's current token says so, read every step), the plan's model through
 * the relay's plan path instead, with its own window and `store: false`
 * (lib/model.ts localAgentPlanStep): never the Gateway, which the relay
 * refuses a free user.
 */
export const macModel = defineDynamic({
  events: {
    'step.started': async (_event, ctx) =>
      localAgentPlanStep() ?? {
        model: (model ??= createLocalAgentModel()),
        modelContextWindowTokens: await macContextWindow(ctx.abortSignal),
      },
  },
})
