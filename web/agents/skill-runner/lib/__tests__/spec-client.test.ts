import { describe, it, expect } from 'vitest'
import { validGatewayTelemetry, type EveSpec } from '../spec-client'

/**
 * skill-runner's spec-client is the ONLY thing the skill-runner eve runtime uses
 * to reach the Next app. `validGatewayTelemetry` is the byte-identical twin of the
 * chat-agent/coding-agent guards; this pins its Phase-A shape contract so a
 * malformed telemetry object NEVER crashes the model resolver (it degrades to the
 * plain model string instead).
 */

describe('validGatewayTelemetry (Phase A shape-guard — never crash the resolver)', () => {
  it('round-trips a well-formed telemetry object through the wire spec type', () => {
    // The gatewayTelemetry field is part of EveSpec; a spec carrying it parses
    // and the guard accepts it verbatim.
    const spec: EveSpec = {
      systemPrompt: 'p',
      model: 'anthropic/claude-haiku-4-5',
      mode: 'act',
      outputContract: 'prose',
      ceiling: null,
      ceilingTools: [],
      gatewayTelemetry: { user: 'user-1', tags: ['feature:run_skill', 'runtime:eve'] },
    }
    expect(validGatewayTelemetry(spec.gatewayTelemetry)).toEqual({
      user: 'user-1',
      tags: ['feature:run_skill', 'runtime:eve'],
    })
  })

  it('accepts an absent user (tags-only attribution)', () => {
    expect(validGatewayTelemetry({ tags: ['feature:run_skill'] })).toEqual({
      tags: ['feature:run_skill'],
    })
  })

  it('strips extra keys, keeping only user + tags', () => {
    expect(validGatewayTelemetry({ user: 'u', tags: ['a'], evil: 'x' })).toEqual({
      user: 'u',
      tags: ['a'],
    })
  })

  for (const bad of [
    undefined,
    null,
    'string',
    42,
    {},
    { tags: 'not-an-array' },
    { tags: [1, 2, 3] },
    { user: 42, tags: ['a'] },
  ]) {
    it(`returns null for malformed input ${JSON.stringify(bad)} (falls back to plain model)`, () => {
      expect(validGatewayTelemetry(bad)).toBeNull()
    })
  }
})
