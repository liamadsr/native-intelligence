import { describe, expect, it } from 'vitest'
import { ContextContainer, contextStorage } from '../../../../node_modules/eve/dist/src/context/container.js'
import { emitStepActions } from '../../../../node_modules/eve/dist/src/harness/step-hooks.js'
import { browserDispatchUsageFor, clearBrowserDispatchStep, recordBrowserDispatchUsage } from '../browser-dispatch-usage-state'

const scope = { turnId: 'turn_0', sequence: 0, stepIndex: 0 }
const metadata = { version: 1, usageUnknown: true, attempts: [
  { generationId: 'gen_first', inputTokens: null, outputTokens: null, usageKnown: false },
  { generationId: 'gen_retry', inputTokens: 10, outputTokens: 5, usageKnown: true },
] }

describe('installed Eve browser usage bridge', () => {
  it('retains real Eve context through an asynchronous model-stream callback and isolates sessions', async () => {
    const session = new ContextContainer()
    const stream = contextStorage.run(session, () => new ReadableStream({
      async start(controller) {
        // Same asynchronous boundary as the middleware's recovery-finish callback.
        await new Promise<void>(resolve => queueMicrotask(resolve))
        recordBrowserDispatchUsage(scope, metadata)
        controller.close()
      },
    }))
    await stream.getReader().read()
    contextStorage.run(session, () => {
      expect(browserDispatchUsageFor(scope)).toEqual(metadata)
      expect(browserDispatchUsageFor({ ...scope, stepIndex: 1 })).toBeNull()
      expect(browserDispatchUsageFor({ ...scope, turnId: 'turn_other' })).toBeNull()
    })
    contextStorage.run(new ContextContainer(), () => expect(browserDispatchUsageFor(scope)).toBeNull())
    const persisted = [...session.entries()].map(([key, value]) => [key.name, value])
    expect(JSON.stringify(persisted)).toContain('gen_first')
  })

  it('retains bounded numeric diagnostics but never raw argument text, arbitrary reasons, or nonfinite counters', () => {
    contextStorage.run(new ContextContainer(), () => {
      recordBrowserDispatchUsage(scope, { ...metadata, reason: 'multiple_calls', prompt: 'private prompt', attempts: [
        { ...metadata.attempts[0], elapsedMs: 153.5, headersMs: 51, toolInputStartMs: 83, toolInputChars: 341, browserCallCount: 2, input: 'private arguments' },
        { ...metadata.attempts[1], elapsedMs: 70, headersMs: null, toolInputStartMs: null, toolInputChars: 0, browserCallCount: 0 },
      ] })
      expect(browserDispatchUsageFor(scope)).toEqual({ ...metadata, reason: 'multiple_calls', attempts: [
        { ...metadata.attempts[0], elapsedMs: 154, headersMs: 51, toolInputStartMs: 83, toolInputChars: 341, browserCallCount: 2 },
        { ...metadata.attempts[1], elapsedMs: 70, headersMs: null, toolInputStartMs: null, toolInputChars: 0, browserCallCount: 0 },
      ] })
      expect(JSON.stringify(browserDispatchUsageFor(scope))).not.toContain('private')
      recordBrowserDispatchUsage(scope, { ...metadata, reason: 'private error prose', attempts: metadata.attempts.map(attempt => ({
        ...attempt, elapsedMs: Infinity, headersMs: -1, toolInputStartMs: 'secret', toolInputChars: NaN, browserCallCount: 1_000_000_001,
      })) })
      expect(browserDispatchUsageFor(scope)).toEqual(metadata)
    })
  })

  it('bounds state and clears only a rerun slot', () => {
    contextStorage.run(new ContextContainer(), () => {
      for (let stepIndex = 0; stepIndex < 70; stepIndex++) recordBrowserDispatchUsage({ ...scope, stepIndex }, metadata)
      expect(browserDispatchUsageFor(scope)).toBeNull()
      expect(browserDispatchUsageFor({ ...scope, stepIndex: 69 })).toEqual(metadata)
      clearBrowserDispatchStep({ ...scope, stepIndex: 69 })
      expect(browserDispatchUsageFor({ ...scope, stepIndex: 69 })).toBeNull()
      expect(browserDispatchUsageFor({ ...scope, stepIndex: 68 })).toEqual(metadata)
    })
  })

  it('persists bounded anonymous envelopes and strips raw IDs, payloads and reasons', () => {
    contextStorage.run(new ContextContainer(), () => {
      const events = [
        { type: 'tool-input-start', id: 'b1', input: 'private arguments' },
        { type: 'tool-input-end', id: 'b1' },
        { type: 'tool-call', id: 'b2', toolName: 'private name' },
        { type: 'finish', reason: 'tool-calls', raw: 'private reason' },
        { type: 'error', reason: 'provider_error', error: 'private error' },
        { type: 'tool-call', id: 'private-provider-id' },
        { type: 'tool-call', id: 'b13' },
        { type: 'finish', reason: 'private reason' },
        { type: 'error', reason: 'private reason' },
        { type: 'text-delta', id: 'b1', delta: 'private text' },
      ]
      recordBrowserDispatchUsage(scope, { ...metadata, attempts: [
        { ...metadata.attempts[0], toolEvents: events, toolEventsTruncated: false }, metadata.attempts[1],
      ] })
      expect(browserDispatchUsageFor(scope)?.attempts[0]).toMatchObject({ toolEvents: [
        { type: 'tool-input-start', id: 'b1' }, { type: 'tool-input-end', id: 'b1' }, { type: 'tool-call', id: 'b2' },
        { type: 'finish', reason: 'tool-calls' }, { type: 'error', reason: 'provider_error' },
      ], toolEventsTruncated: false })
      expect(JSON.stringify(browserDispatchUsageFor(scope))).not.toContain('private')
      recordBrowserDispatchUsage(scope, { ...metadata, attempts: [
        { ...metadata.attempts[0], toolEvents: Array.from({ length: 30 }, () => events[0]) },
      ] })
      expect(browserDispatchUsageFor(scope)?.attempts[0].toolEvents).toHaveLength(12)
      expect(browserDispatchUsageFor(scope)?.attempts[0].toolEventsTruncated).toBe(true)
    })
  })

  it('pins the installed Eve projection: amounts survive but custom provider metadata is dropped', async () => {
    const events: unknown[] = []
    await emitStepActions(async event => { events.push(event) },
      { turnId: 'turn_0', sequence: 0, stepIndex: 0 } as Parameters<typeof emitStepActions>[1],
      {
        content: [], text: '', toolCalls: [], toolResults: [], response: { messages: [] }, finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        providerMetadata: { gateway: { generationId: 'gen_retry', cost: 0.02 }, browserDispatch: metadata },
      } as unknown as Parameters<typeof emitStepActions>[2],
      { tools: new Map(), excludedActionToolNames: new Set() })
    expect(events).toEqual([expect.objectContaining({ type: 'step.completed', data: expect.objectContaining({
      providerMetadata: { gateway: { generationId: 'gen_retry' } },
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, costUsd: 0.02 }),
    }) })])
  })
})
