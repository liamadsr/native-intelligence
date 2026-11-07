/**
 * This turn's model selection, as the model resolver (./chat-model.ts) chose
 * it: durable session state, so it survives memo expiry and process changes,
 * and a later model step never silently switches Max to Light on a spec
 * outage. Its own module so the tool dispatch (./spec-client.ts) can read the
 * turn's model without importing the resolver (which imports the dispatch).
 *
 * The tool dispatch sends the model with review_post alone (content C0): the
 * post reviewer must be another vendor than the writer, and the writer is
 * this turn's model. It rides the authenticated envelope, never the model's
 * input.
 */
import { defineState } from 'eve/context'
import type { ModelSelection } from './spec-client.js'

export const turnModelSelection = defineState<ModelSelection | null>('chat-agent.turn-model-selection', () => null)

/** The model this turn runs on (a Gateway slug), or null before the resolver ran. */
export function currentTurnModel(): string | null {
  try {
    const selection = turnModelSelection.get()
    // A selection is a bare model id or an object carrying one.
    const model = typeof selection === 'string' ? selection : selection?.model
    return typeof model === 'string' && model ? model : null
  } catch {
    return null
  }
}
