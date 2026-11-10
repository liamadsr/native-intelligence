import { describe, it, expect } from 'vitest'
import { mapEveTurnUsage, exaCostOf } from '../eve-usage'
import type { HandleMessageStreamEvent } from 'eve/client'

/**
 * Locks the eve → logUsage mapping (Phase 4, Stage 3):
 *   - a BYOK cost of 0 (or absent) maps to costUsd:null so logUsage OMITS
 *     costUsd and the RPC prices from ai_model_costs (same call as run-skill-eve);
 *   - a genuinely non-zero eve cost passes through faithfully;
 *   - durationMs is computed from the first/last event meta.at bracket, and a
 *     caller-supplied wallMs overrides it;
 *   - tokens sum across step.completed; toolCalls/toolDiscoveries count from
 *     actions.requested (search_tools = a discovery), mirroring the cloud route.
 */

// Minimal event builders — only the fields mapEveTurnUsage reads.
function stepCompleted(
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined,
  at?: string,
  // The gateway generationId rides ev.data.providerMetadata.gateway.generationId
  // in the eve contract (StepCompletedProviderMetadata) — pass it in raw so the
  // malformed cases can supply arbitrary shapes.
  providerMetadata?: unknown,
): HandleMessageStreamEvent {
  return {
    type: 'step.completed',
    data: {
      finishReason: 'stop',
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
      usage,
      ...(providerMetadata !== undefined ? { providerMetadata } : {}),
    },
    ...(at ? { meta: { at } } : {}),
  } as unknown as HandleMessageStreamEvent
}

/** Build a well-formed providerMetadata carrying a gateway generationId. */
function gatewayMeta(generationId: unknown): unknown {
  return { gateway: { generationId } }
}

function actionsRequested(toolNames: string[], at?: string): HandleMessageStreamEvent {
  return {
    type: 'actions.requested',
    data: {
      actions: toolNames.map((toolName) => ({ toolName })),
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
    },
    ...(at ? { meta: { at } } : {}),
  } as unknown as HandleMessageStreamEvent
}

/** An `action.result` event carrying a tool output (a provider web_search's Exa JSON, or any tool's). */
function actionResult(toolName: string, output: unknown): HandleMessageStreamEvent {
  return {
    type: 'action.result',
    data: {
      result: { kind: 'tool-result', callId: `c_${toolName}`, toolName, output },
      sequence: 0,
      stepIndex: 0,
      status: 'completed',
      turnId: 't',
    },
  } as unknown as HandleMessageStreamEvent
}

describe('mapEveTurnUsage', () => {
  it('sums input/output tokens across step.completed events', () => {
    const m = mapEveTurnUsage([
      stepCompleted({ inputTokens: 100, outputTokens: 20 }),
      stepCompleted({ inputTokens: 50, outputTokens: 10 }),
    ])
    expect(m.inputTokens).toBe(150)
    expect(m.outputTokens).toBe(30)
    expect(m.steps).toBe(2)
  })

  it('maps a 0 (BYOK) cost to null so the RPC prices from the table', () => {
    const m = mapEveTurnUsage([stepCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0 })])
    expect(m.costUsd).toBeNull()
  })

  it('maps an absent cost to null', () => {
    const m = mapEveTurnUsage([stepCompleted({ inputTokens: 10, outputTokens: 5 })])
    expect(m.costUsd).toBeNull()
  })

  it('passes a genuinely non-zero eve cost through faithfully', () => {
    const m = mapEveTurnUsage([
      stepCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.012 }),
      stepCompleted({ inputTokens: 8, outputTokens: 3, costUsd: 0.003 }),
    ])
    expect(m.costUsd).toBeCloseTo(0.015, 6)
  })

  it('a cost reported by only SOME steps is a partial cost → null, so the RPC prices every summed token', () => {
    const m = mapEveTurnUsage([
      stepCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.012 }),
      stepCompleted({ inputTokens: 9000, outputTokens: 300 }),
    ])
    expect(m.costUsd).toBeNull()
    expect(m.inputTokens).toBe(9010)
    // A step with no usage object at all carries no tokens either — not partial.
    const whole = mapEveTurnUsage([stepCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.012 }), stepCompleted(undefined)])
    expect(whole.costUsd).toBeCloseTo(0.012, 6)
  })

  it('a numeric 0 (BYOK) on one token-spending step is uncosted too → null, not the other steps\' partial cost', () => {
    const m = mapEveTurnUsage([
      stepCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.012 }),
      stepCompleted({ inputTokens: 9000, outputTokens: 300, costUsd: 0 }),
    ])
    expect(m.costUsd).toBeNull()
    expect(m.inputTokens).toBe(9010)
    // A 0-cost step that spent no tokens hides no spend — the cost stays whole.
    const whole = mapEveTurnUsage([
      stepCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.012 }),
      stepCompleted({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    ])
    expect(whole.costUsd).toBeCloseTo(0.012, 6)
  })

  it('computes durationMs from the first/last event meta.at bracket', () => {
    const start = '2026-07-10T00:00:00.000Z'
    const end = '2026-07-10T00:00:04.500Z'
    const m = mapEveTurnUsage([
      stepCompleted({ inputTokens: 1, outputTokens: 1 }, start),
      stepCompleted({ inputTokens: 1, outputTokens: 1 }, end),
    ])
    expect(m.durationMs).toBe(4500)
  })

  it('prefers a caller-supplied wallMs over the event bracket', () => {
    const m = mapEveTurnUsage(
      [
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, '2026-07-10T00:00:00.000Z'),
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, '2026-07-10T00:00:04.500Z'),
      ],
      { wallMs: 9999 },
    )
    expect(m.durationMs).toBe(9999)
  })

  it('degrades durationMs to 0 when no event carries a timestamp', () => {
    const m = mapEveTurnUsage([stepCompleted({ inputTokens: 1, outputTokens: 1 })])
    expect(m.durationMs).toBe(0)
  })

  it('counts tool calls and flags search_tools as a discovery', () => {
    const m = mapEveTurnUsage([
      actionsRequested(['search_tools', 'ni_create_action']),
      stepCompleted({ inputTokens: 10, outputTokens: 5 }),
      actionsRequested(['ni_list_actions']),
    ])
    expect(m.toolCalls).toBe(3)
    expect(m.toolDiscoveries).toBe(1)
  })

  describe('Exa contamination (eve 0.66.3: step costUsd is the Gateway BILLED cost, Exa included)', () => {
    it('drops eve’s cost when any action.result carries costDollars.total, and reports the Exa spend', () => {
      // The measured live case: BYOK tokens billed $0, the whole 0.007 was Exa.
      const m = mapEveTurnUsage([
        actionResult('web_search', { results: [], costDollars: { total: 0.007, search: { neural: 0.007 } } }),
        stepCompleted({ inputTokens: 8100, outputTokens: 120, costUsd: 0.007 }),
      ])
      expect(m.costUsd).toBeNull() // → logUsage omits it → RPC list-prices the 8.1k tokens
      expect(m.webSearchCostUsd).toBeCloseTo(0.007)
      expect(m.inputTokens).toBe(8100)
    })

    it('sums Exa spend across several searches; a credits-path positive cost is still dropped', () => {
      const m = mapEveTurnUsage([
        actionResult('web_search', { costDollars: { total: 0.005 } }),
        stepCompleted({ inputTokens: 100, outputTokens: 10, costUsd: 0.02 }),
        actionResult('web_search', { costDollars: { total: 0.01 } }),
        stepCompleted({ inputTokens: 200, outputTokens: 20, costUsd: 0.03 }),
      ])
      expect(m.costUsd).toBeNull()
      expect(m.webSearchCostUsd).toBeCloseTo(0.015)
    })

    it('a turn with no Exa result keeps a trusted positive cost and reports webSearchCostUsd null', () => {
      const m = mapEveTurnUsage([
        actionResult('ni_list_actions', { rows: [] }),
        stepCompleted({ inputTokens: 100, outputTokens: 10, costUsd: 0.02 }),
      ])
      expect(m.costUsd).toBeCloseTo(0.02)
      expect(m.webSearchCostUsd).toBeNull()
    })

    it('exaCostOf matches by shape and never throws on malformed data', () => {
      expect(exaCostOf({ result: { output: { costDollars: { total: 0.004 } } } })).toBe(0.004)
      for (const bad of [null, undefined, 1, {}, { result: null }, { result: { output: 'x' } },
        { result: { output: { costDollars: { total: '0.1' } } } },
        { result: { output: { costDollars: { total: Number.NaN } } } }]) {
        expect(exaCostOf(bad)).toBeNull()
      }
    })
  })

  it('never throws on a malformed/empty stream', () => {
    expect(() => mapEveTurnUsage([])).not.toThrow()
    const m = mapEveTurnUsage([])
    expect(m).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      webSearchCostUsd: null,
      durationMs: 0,
      steps: 0,
      toolCalls: 0,
      toolDiscoveries: 0,
      generationIds: [],
    })
  })

  describe('generationIds (gateway /v1/report join key)', () => {
    it('collects gateway generationIds from step.completed events', () => {
      const m = mapEveTurnUsage([
        stepCompleted({ inputTokens: 10, outputTokens: 5 }, undefined, gatewayMeta('gen_a')),
        stepCompleted({ inputTokens: 8, outputTokens: 3 }, undefined, gatewayMeta('gen_b')),
      ])
      expect(m.generationIds).toEqual(['gen_a', 'gen_b'])
    })

    it('dedupes repeated generationIds while preserving first-seen order', () => {
      const m = mapEveTurnUsage([
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, undefined, gatewayMeta('gen_b')),
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, undefined, gatewayMeta('gen_a')),
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, undefined, gatewayMeta('gen_b')),
      ])
      expect(m.generationIds).toEqual(['gen_b', 'gen_a'])
    })

    it('caps the collected generationIds at 50', () => {
      const events = Array.from({ length: 60 }, (_, i) =>
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, undefined, gatewayMeta(`gen_${i}`)),
      )
      const m = mapEveTurnUsage(events)
      expect(m.generationIds).toHaveLength(50)
      expect(m.generationIds[0]).toBe('gen_0')
      expect(m.generationIds[49]).toBe('gen_49')
    })

    it('returns [] when no event carries providerMetadata', () => {
      const m = mapEveTurnUsage([stepCompleted({ inputTokens: 10, outputTokens: 5 })])
      expect(m.generationIds).toEqual([])
    })

    it('ignores malformed providerMetadata shapes without throwing', () => {
      const cases: unknown[] = [
        null,
        'not-an-object',
        {}, // no gateway key
        { gateway: null }, // gateway not an object
        { gateway: {} }, // no generationId
        gatewayMeta(42), // generationId not a string
        gatewayMeta(''), // empty string
        gatewayMeta('   '), // whitespace-only
      ]
      const m = mapEveTurnUsage(
        cases.map((meta) => stepCompleted({ inputTokens: 1, outputTokens: 1 }, undefined, meta)),
      )
      expect(m.generationIds).toEqual([])
      expect(m.steps).toBe(cases.length) // still counted the steps
    })

    it('trims surrounding whitespace on a valid generationId', () => {
      const m = mapEveTurnUsage([
        stepCompleted({ inputTokens: 1, outputTokens: 1 }, undefined, gatewayMeta('  gen_x  ')),
      ])
      expect(m.generationIds).toEqual(['gen_x'])
    })
  })
})
