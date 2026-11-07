import { describe, it, expect } from 'vitest'
import {
  createPrepareStep,
  computeToolCeiling,
  computeInitialActiveTools,
  createSearchToolsTool,
  CORE_TOOL_NAMES,
  ALWAYS_ON_CAPABILITY_TOOL_NAMES,
} from '../tool-discovery'
import { ALL_CATEGORY_IDS, getToolNamesForCategories } from '../tool-registry'

/** Build a `steps` array mimicking one prior `search_tools` call returning `names`. */
function searchToolsSteps(names: string[]) {
  return [
    {
      toolResults: [
        {
          toolName: 'search_tools',
          output: { tools: names.map((name) => ({ name })) },
        },
      ],
    },
  ]
}

describe('createPrepareStep — allowedCeiling clamp', () => {
  it('without a ceiling, unions every discovered tool that exists (today behavior)', () => {
    const initial = ['search', 'list_actions', 'search_tools']
    const available = new Set([...initial, 'create_project', 'list_emails'])
    const prepare = createPrepareStep(initial, available /* no ceiling */)

    const result = prepare({ steps: searchToolsSteps(['create_project', 'list_emails']) })

    expect(result.activeTools).toEqual(
      expect.arrayContaining([...initial, 'create_project', 'list_emails']),
    )
  })

  it('with a ceiling, excludes discovered tools outside it but keeps allowed ones', () => {
    const initial = ['search', 'list_actions', 'search_tools']
    const available = new Set([...initial, 'create_project', 'create_action'])
    const ceiling = new Set(['search', 'list_actions', 'search_tools', 'create_action'])
    const prepare = createPrepareStep(initial, available, ceiling)

    // The model "sees" create_project via search_tools but it must NOT activate.
    const result = prepare({ steps: searchToolsSteps(['create_project', 'create_action']) })

    expect(result.activeTools).toContain('create_action')
    expect(result.activeTools).not.toContain('create_project')
  })

  it('returns {} (no change) when nothing new is discovered', () => {
    const prepare = createPrepareStep(['search'], new Set(['search']))
    expect(prepare({ steps: [] })).toEqual({})
  })
})

describe('computeToolCeiling', () => {
  it('returns null (inherit-all) when all categories enabled and nothing disabled', () => {
    expect(computeToolCeiling([...ALL_CATEGORY_IDS], [])).toBeNull()
  })

  it('returns a bounded set when a subset of categories is enabled', () => {
    const ceiling = computeToolCeiling(['actions'], [])
    expect(ceiling).not.toBeNull()
    // Core tools are always in the ceiling.
    for (const core of CORE_TOOL_NAMES) {
      expect(ceiling!.has(core)).toBe(true)
    }
    // Tools from the enabled 'actions' category are present...
    for (const name of getToolNamesForCategories(['actions'])) {
      expect(ceiling!.has(name)).toBe(true)
    }
    // ...but a tool from a non-enabled category (projects) is not (unless core).
    const projectsTools = getToolNamesForCategories(['projects']).filter(
      (n) => !CORE_TOOL_NAMES.includes(n) && !getToolNamesForCategories(['actions']).includes(n),
    )
    for (const name of projectsTools) {
      expect(ceiling!.has(name)).toBe(false)
    }
  })

  it('honors disabled_tools by excluding them from the ceiling (unless core)', () => {
    const actionsTools = getToolNamesForCategories(['actions'])
    // Pick an actions tool that is NOT a core tool, so disabling it actually removes it.
    const target = actionsTools.find((n) => !CORE_TOOL_NAMES.includes(n))
    expect(target).toBeDefined()
    const ceiling = computeToolCeiling(['actions'], [target!])
    expect(ceiling!.has(target!)).toBe(false)
  })

  it('treats all-enabled but with a disabled tool as a real ceiling (not inherit-all)', () => {
    const ceiling = computeToolCeiling([...ALL_CATEGORY_IDS], ['list_emails'])
    expect(ceiling).not.toBeNull()
    expect(ceiling!.has('list_emails')).toBe(false)
  })
})

describe('computeInitialActiveTools (unchanged baseline)', () => {
  it('returns CORE_TOOL_NAMES + the always-on capabilities when no skill categories supplied', () => {
    // Web access is an always-on CAPABILITY, seeded alongside the core set
    // rather than inside it — CORE_TOOL_NAMES feeds the eve specs' coreToolNames
    // and `web_search` there would shadow eve's native provider tool. See
    // ./web-search-always-on.test.ts and ./web-search-spec-collision.test.ts.
    expect(computeInitialActiveTools()).toEqual([
      ...CORE_TOOL_NAMES,
      ...ALWAYS_ON_CAPABILITY_TOOL_NAMES,
    ])
  })
})

describe('search_tools category hint — drift guard', () => {
  // The advertised category list is derived from ALL_CATEGORY_IDS so it can never
  // drift from the registry again (it previously omitted `knowledge` and `flows`,
  // making those tools discoverable only by lucky token match — the audit gap
  // this Phase 0 fix closes).
  const description = (createSearchToolsTool() as { description?: string }).description ?? ''

  it('advertises every registry category id', () => {
    for (const id of ALL_CATEGORY_IDS) {
      expect(description).toContain(id)
    }
  })

  it('includes the previously-omitted knowledge and flows categories', () => {
    expect(description).toContain('knowledge')
    expect(description).toContain('flows')
  })
})
