/**
 * Tests for the agent-run status vocabulary — the single source of truth that
 * replaces the ~13-site liveness duplication (Loops v3 Phase 3 —
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md §"Status vocabulary").
 *
 * The load-bearing facts every re-pointing site depends on:
 *   - needs_input is LIVE (poll it, cancelable), NOT terminal;
 *   - pr_open is TERMINAL (a coding outcome), NOT live;
 *   - the terminal + live sets partition the full status union with no overlap;
 *   - an unknown status is neither live nor terminal (so `toWorkRunStatus`-style
 *     degradation must handle it explicitly, not fall through a liveness check).
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_RUN_TERMINAL_STATUSES,
  AGENT_RUN_LIVE_STATUSES,
  WORK_RESOURCE_TYPES,
  isAgentRunLive,
  isAgentRunTerminal,
  type AgentRunStatus,
} from '../types'
// WORK_RESOURCE_TYPES is now DERIVED from the entity registry instead of being
// a hand-copied duplicate, so this suite asserts the derivation holds AND that
// claims.ts re-exports the very same object — that re-export is the import path
// every existing call site uses, and a stale local copy there would reintroduce
// the drift the registry removed. Tests run in node, so importing the server
// module is safe here even though types.ts itself is client-bundled.
import { LINKABLE_ENTITY_TYPES } from '@/lib/ai/tools/claims'
import { LINKABLE_ENTITY_TYPES as REGISTRY_LINKABLE } from '@/lib/knowledge/entity-registry'

const ALL: AgentRunStatus[] = [
  'queued',
  'running',
  'needs_input',
  'canceling',
  'pr_open',
  'completed',
  'failed',
  'canceled',
]

describe('agent-run status vocabulary', () => {
  it('classifies needs_input as live (not terminal)', () => {
    expect(isAgentRunLive('needs_input')).toBe(true)
    expect(isAgentRunTerminal('needs_input')).toBe(false)
  })

  it('classifies pr_open as terminal (not live)', () => {
    expect(isAgentRunTerminal('pr_open')).toBe(true)
    expect(isAgentRunLive('pr_open')).toBe(false)
  })

  it('the live + terminal sets partition every status with no overlap', () => {
    for (const s of ALL) {
      const live = isAgentRunLive(s)
      const terminal = isAgentRunTerminal(s)
      // Exactly one of live/terminal is true for every real status.
      expect(live).not.toBe(terminal)
    }
    // Union covers every status exactly once.
    const union = new Set([...AGENT_RUN_LIVE_STATUSES, ...AGENT_RUN_TERMINAL_STATUSES])
    expect(union.size).toBe(ALL.length)
    for (const s of ALL) expect(union.has(s)).toBe(true)
  })

  it('an unknown status is neither live nor terminal', () => {
    expect(isAgentRunLive('bogus')).toBe(false)
    expect(isAgentRunTerminal('bogus')).toBe(false)
  })
})

describe('WORK_RESOURCE_TYPES parity with LINKABLE_ENTITY_TYPES', () => {
  // The contract, now enforced by derivation rather than by hand: adding a type
  // to the registry widens WORK_RESOURCE_TYPES with no second edit.
  it('equals [...LINKABLE_ENTITY_TYPES, "package"] in order', () => {
    expect([...WORK_RESOURCE_TYPES]).toEqual([...LINKABLE_ENTITY_TYPES, 'package'])
  })

  it("claims.ts's re-export IS the registry's array, not a copy of it", () => {
    expect(LINKABLE_ENTITY_TYPES).toBe(REGISTRY_LINKABLE)
  })

  it('every linkable entity type is present as a resource type', () => {
    for (const t of LINKABLE_ENTITY_TYPES) {
      expect(WORK_RESOURCE_TYPES).toContain(t)
    }
    expect(WORK_RESOURCE_TYPES).toContain('package')
  })
})
