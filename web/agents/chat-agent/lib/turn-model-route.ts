/**
 * How this turn's model was chosen (auto model selection: the spec's
 * `modelRoute`, src/lib/ai/model-route.ts), kept for the turn's usage report.
 *
 * The model resolver (./chat-model.ts, or a roster helper's: ./helper-models.ts) writes it at
 * turn.started, from the same spec it selects the model from; the usage meter
 * (../hooks/usage-meter.ts) reads it when the turn settles and sends it with
 * the report, and the usage route writes it to ai_usage_logs.metadata
 * .model_route. Durable session state, so it survives the step boundaries a
 * turn crosses; a helper's child session keeps its own.
 */
import { defineState } from 'eve/context'
import { validModelRoute, type ReportedModelRoute } from './turn-usage.js'

const turnModelRoute = defineState<ReportedModelRoute | null>('chat-agent.turn-model-route', () => null)

/** Record this turn's route (null when the spec carried none). */
export function setTurnModelRoute(route: unknown): void {
  turnModelRoute.update(() => validModelRoute(route))
}

/** This turn's route, or null. */
export function currentTurnModelRoute(): ReportedModelRoute | null {
  return validModelRoute(turnModelRoute.get())
}
