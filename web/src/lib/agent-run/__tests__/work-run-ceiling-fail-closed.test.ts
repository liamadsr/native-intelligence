/**
 * The work-run ceiling fails CLOSED on bad registry data.
 *
 * tsc refuses a registry entry with no `sideEffect`, but a value can still be
 * forced in with an `as` cast, and a name could be registered twice with two
 * different classes. Neither may widen the ceiling: an unknown class is not an
 * admitted class, and a name with ANY non-admitted entry is excluded. This file
 * swaps in a registry with those defects and checks both the derived exclusion
 * list and computeWorkRunCeiling.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolCategory, ToolDefinition } from '@/lib/ai/tool-registry'

vi.mock('@/lib/ai/tool-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-registry')>()
  const extra: ToolCategory = {
    id: 'test_defects',
    label: 'Test defects',
    description: 'registry defects the ceiling must survive',
    icon: 'x',
    tools: [
      // An unknown class smuggled past the type system (the whole entry is
      // cast: ToolDefinition is a discriminated union on sideEffect now).
      { name: 'mystery_tool', sideEffect: 'harmless', label: 'M', description: 'm' } as unknown as ToolDefinition,
      // The same name twice: once admitted, once not.
      { name: 'twice_tool', sideEffect: 'read', label: 'T1', description: 't' },
      { name: 'twice_tool', sideEffect: 'external-write', label: 'T2', description: 't' },
      // A well-formed admitted entry, as a control.
      { name: 'plain_read_tool', sideEffect: 'read', label: 'P', description: 'p' },
    ],
  }
  const TOOL_CATEGORIES = [...actual.TOOL_CATEGORIES, extra]
  return {
    ...actual,
    TOOL_CATEGORIES,
    ALL_TOOL_NAMES: TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)),
  }
})

// Imported after the mock so both modules read the defective registry.
const { computeWorkRunCeiling } = await import('../run-work-spec-rebuild')
const { WORK_RUN_EXCLUDED_TOOLS } = await import('../types')

describe('work-run ceiling on defective registry data', () => {
  const ceiling = computeWorkRunCeiling()

  it('excludes a tool whose class is not one of the admitted strings', () => {
    expect(ceiling.has('mystery_tool')).toBe(false)
    expect(WORK_RUN_EXCLUDED_TOOLS).toContain('mystery_tool')
  })

  it('excludes a duplicated name when any of its entries is not admitted', () => {
    expect(ceiling.has('twice_tool')).toBe(false)
    expect(WORK_RUN_EXCLUDED_TOOLS).toContain('twice_tool')
  })

  it('still admits a well-formed read (the mock really reached the ceiling)', () => {
    expect(ceiling.has('plain_read_tool')).toBe(true)
    expect(ceiling.has('list_actions')).toBe(true)
    expect(ceiling.has('publish_draft')).toBe(false)
  })
})
