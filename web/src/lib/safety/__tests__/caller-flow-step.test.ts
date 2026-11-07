/**
 * F4 (flows-connectors.md §2.3), pinned on both sides: an unattended caller's
 * OUTWARD call on a flow step is the owner's approval card ('ask'), and every
 * other unattended path keeps 'deny'. The flowStep option reads for nothing
 * but an unattended caller's outward call.
 */
import { describe, expect, it } from 'vitest'
import { CALLER_CLASSES, decideAction } from '../caller'

describe('decideAction: a flow step', () => {
  it('agent_unattended + outward on a flow step → ask (a card, not a refusal)', () => {
    expect(decideAction('agent_unattended', 'outward', 'mcp__typefully__create_draft', { flowStep: true })).toBe('ask')
  })

  it('agent_unattended + outward anywhere else → deny (unchanged)', () => {
    expect(decideAction('agent_unattended', 'outward', 'mcp__typefully__create_draft')).toBe('deny')
    expect(decideAction('agent_unattended', 'outward', 'mcp__typefully__create_draft', { flowStep: false })).toBe('deny')
    expect(decideAction('agent_unattended', 'outward', 'create_calendar_event', { granted: true })).toBe('deny')
  })

  it('flowStep changes nothing for any other class or effect', () => {
    for (const caller of CALLER_CLASSES) {
      for (const effect of ['read', 'internal-write', 'external-write', 'delete', 'automation-write', 'unclassified'] as const) {
        expect(decideAction(caller, effect, 'list_actions', { flowStep: true }), `${caller}/${effect}`).toBe(decideAction(caller, effect, 'list_actions'))
      }
      if (caller !== 'agent_unattended') {
        expect(decideAction(caller, 'outward', 'mcp__x__y', { flowStep: true }), caller).toBe(decideAction(caller, 'outward', 'mcp__x__y'))
      }
    }
    // An attended-only tool on an unattended flow step stays denied.
    expect(decideAction('agent_unattended', 'automation-write', 'create_flow', { flowStep: true })).toBe('deny')
  })
})
