/**
 * The index of the step a `step.started` MODEL RESOLVER is choosing for.
 *
 * eve 0.79 fills the resolver event's `stepIndex` from the turn's position
 * BEFORE the step starts (harness/model-call/run.js selectModel →
 * session-projection.js turnCoordinates), so past the first step it names the
 * PREVIOUS step: 0, 0, 1, 2, … for steps 0, 1, 2, 3 (eve 0.66.3 read 0, 1, 2).
 * The stream's own `step.started` event, which hooks read, carries the true
 * index. Usage recorded under the resolver's index must match it, or the meter
 * (hooks/usage-meter.ts, keyed by the stream event) never finds it.
 *
 * Past step 0 the true index is one more than the reported one. When eve
 * reports 0 it is step 0 or step 1, told apart by ctx.messages: a step that
 * ran left an assistant message after the turn's user message. (A steering
 * message right after step 0 hides it; that one step then reads as 0, as
 * before.) agents/utility/lib/spec-client.ts stepIndexOf applies the same
 * rule; its contract test pins eve's reporting.
 */
export function resolverStepIndex(reported: number, messages: readonly unknown[] = []): number {
  if (reported > 0) return reported + 1
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role?: unknown } | null)?.role
    if (role === 'user') return 0
    if (role === 'assistant') return 1
  }
  return 0
}
