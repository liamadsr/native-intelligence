import 'server-only'
import { decide } from 'eve/ai'
import type { Questions } from '../contracts'
import type { GatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'

export const JEV_MODEL = 'typesafe-ai/jev'
/**
 * Sole pinned exception to the Eve agent rule: guarded and metered by runDecision.
 * eve 0.72 renamed eve/ai's `evaluate` to `decide` (the AI SDK's evaluation →
 * decisions rename); the call and its result shape are otherwise unchanged.
 */
export function evaluateJev(state: string, questions: Questions, signal: AbortSignal, telemetry: GatewayTelemetryValues | null) {
  return decide({ model: JEV_MODEL, state, questions, abortSignal: signal, maxRetries: 0,
    ...(telemetry ? { providerOptions: { gateway: telemetry } } : {}) })
}
