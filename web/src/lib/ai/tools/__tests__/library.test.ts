/**
 * Tests for the skill-authoring tools in library.ts — the tool surface behind
 * the /create-skill system skill (migration 225), which replaced the hardcoded
 * "Save as skill" button.
 *
 * Invariants locked in:
 *  - create_skill stamps workspace/creator/category and is_system=false, and
 *    defaults visibility to 'personal' so a model can't publish to the team.
 *  - Slug collisions self-heal via ensureUniqueSlug (base → base-2) rather than
 *    erroring, and the tool reports the slug that ACTUALLY landed.
 *  - Reserved slugs are rejected.
 *  - System skills are read-only through update_skill — the guard fires before
 *    any write is attempted.
 *
 * Vitest unit tests (no network, no DB). Run via `npm test`.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createLibraryTools, orFilterValue } from '../library'

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const SKILL_ID = 'skill-uuid-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Result = { data: unknown; error: { message: string } | null }

/**
 * A `recipe`-table mock that serves a SEQUENCE of results — one per awaited
 * query — because these tools hit the table several times per call (the
 * ensureUniqueSlug probe, then the insert/update). Captures the payload passed
 * to insert()/update() so tests can assert on what would be written.
 */
function recipeMock(sequence: Result[]) {
  const captured: { insert?: Record<string, unknown>; update?: Record<string, unknown> } = {}
  let i = 0
  const next = () => sequence[Math.min(i++, sequence.length - 1)]

  const makeChain = (): Record<string, unknown> => {
    // Resolve lazily: the result is claimed when the chain is awaited, so
    // queries consume the sequence in execution order rather than build order.
    let claimed: Result | undefined
    const settle = () => (claimed ??= next())

    // Declared up front so insert()/update() can close over it; assigned below.
    let proxy: Record<string, unknown>

    const chain: Record<string, unknown> = {
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      single: vi.fn(() => {
        const r = settle()
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data
        return Promise.resolve({ data, error: r.error })
      }),
      insert: vi.fn((payload: Record<string, unknown>) => {
        captured.insert = payload
        return proxy
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        captured.update = payload
        return proxy
      }),
    }
    chain.maybeSingle = chain.single

    // Return the PROXY from every builder method, not the bare `chain` — the
    // fallthrough below only exists on the proxy, so handing back `chain`
    // breaks the second hop of a multi-.eq() chain.
    proxy = new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        // Any other builder method (select/eq/or/order/neq/limit/not/is/delete)
        // just continues the chain.
        return () => proxy
      },
    })
    return proxy
  }

  const supabase = { from: vi.fn(() => makeChain()) }
  return { supabase, captured }
}

function tools(supabase: unknown) {
  return createLibraryTools(USER_ID, supabase as never, WORKSPACE_ID)
}

describe('create_skill', () => {
  const DRAFT = {
    name: 'Draft release notes',
    description: 'When the user wants release notes from a list of commits.',
    system_prompt: '# Release notes\n\nGroup commits by feature, then list fixes.',
  }

  it('creates a workspace-scoped, non-system skill defaulting to personal visibility', async () => {
    const { supabase, captured } = recipeMock([
      // ensureUniqueSlug's namespace probe — nothing taken.
      { data: [], error: null },
      // the insert
      { data: { id: SKILL_ID, slug: 'draft-release-notes' }, error: null },
    ])

    const result = (await tools(supabase).create_skill.execute!(DRAFT, EXEC_OPTS)) as {
      success: boolean
      command: string
    }

    expect(result.success).toBe(true)
    expect(captured.insert).toMatchObject({
      workspace_id: WORKSPACE_ID,
      created_by: USER_ID,
      category: 'skill',
      is_system: false,
      // The model never chooses to publish — personal unless asked.
      visibility: 'personal',
      slug: 'draft-release-notes',
      name: DRAFT.name,
    })
    // Tells the user the command that actually landed.
    expect(result.command).toBe('/draft-release-notes')
  })

  it('honors an explicit wider visibility when the user asked to share', async () => {
    const { supabase, captured } = recipeMock([
      { data: [], error: null },
      { data: { id: SKILL_ID }, error: null },
    ])

    await tools(supabase).create_skill.execute!({ ...DRAFT, visibility: 'workspace' }, EXEC_OPTS)

    expect(captured.insert).toMatchObject({ visibility: 'workspace' })
  })

  it('self-heals a slug collision by suffixing instead of failing', async () => {
    const { supabase, captured } = recipeMock([
      // The namespace probe reports the base slug already taken — note this
      // spans BOTH namespaces (a system row can own it), which is why these
      // tools use ensureUniqueSlug rather than the MCP tool's workspace-only check.
      { data: [{ id: 'other', slug: 'draft-release-notes' }], error: null },
      { data: { id: SKILL_ID }, error: null },
    ])

    const result = (await tools(supabase).create_skill.execute!(DRAFT, EXEC_OPTS)) as {
      success: boolean
      command: string
    }

    expect(result.success).toBe(true)
    expect(captured.insert).toMatchObject({ slug: 'draft-release-notes-2' })
    expect(result.command).toBe('/draft-release-notes-2')
  })

  it('rejects a reserved slug before touching the table', async () => {
    const { supabase, captured } = recipeMock([{ data: [], error: null }])

    const result = (await tools(supabase).create_skill.execute!(
      { ...DRAFT, slug: 'help' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/reserved/i)
    expect(captured.insert).toBeUndefined()
  })

  it('requires a non-empty name and prompt', async () => {
    const { supabase } = recipeMock([{ data: [], error: null }])
    const t = tools(supabase)

    const noName = (await t.create_skill.execute!({ ...DRAFT, name: '   ' }, EXEC_OPTS)) as {
      success: boolean
    }
    const noPrompt = (await t.create_skill.execute!(
      { ...DRAFT, system_prompt: '  ' },
      EXEC_OPTS,
    )) as { success: boolean }

    expect(noName.success).toBe(false)
    expect(noPrompt.success).toBe(false)
  })

  it('surfaces a write failure instead of reporting success', async () => {
    const { supabase } = recipeMock([
      { data: [], error: null },
      { data: null, error: { message: 'permission denied for table recipe' } },
    ])

    const result = (await tools(supabase).create_skill.execute!(DRAFT, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission denied/)
  })
})

describe('update_skill', () => {
  it('refuses to modify a system skill and never issues the update', async () => {
    const { supabase, captured } = recipeMock([
      // fetchEditableSkill's guard read.
      { data: { id: SKILL_ID, is_system: true, category: 'skill', workspace_id: null }, error: null },
    ])

    const result = (await tools(supabase).update_skill.execute!(
      { id: SKILL_ID, name: 'Hijacked' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/system skill/i)
    // The guard fires BEFORE any write is attempted.
    expect(captured.update).toBeUndefined()
  })

  it('rejects an id that is not a skill', async () => {
    const { supabase, captured } = recipeMock([
      {
        data: { id: SKILL_ID, is_system: false, category: 'agent', workspace_id: WORKSPACE_ID },
        error: null,
      },
    ])

    const result = (await tools(supabase).update_skill.execute!(
      { id: SKILL_ID, name: 'Nope' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not a skill/i)
    expect(captured.update).toBeUndefined()
  })

  it('updates only the fields passed', async () => {
    const { supabase, captured } = recipeMock([
      {
        data: {
          id: SKILL_ID,
          is_system: false,
          category: 'skill',
          workspace_id: WORKSPACE_ID,
          created_by: USER_ID,
          visibility: 'personal',
        },
        error: null,
      },
      { data: { id: SKILL_ID, description: 'New trigger.' }, error: null },
    ])

    const result = (await tools(supabase).update_skill.execute!(
      { id: SKILL_ID, description: 'New trigger.' },
      EXEC_OPTS,
    )) as { success: boolean }

    expect(result.success).toBe(true)
    expect(captured.update).toEqual({ description: 'New trigger.' })
  })

  it('rejects an update with no fields to change', async () => {
    const { supabase, captured } = recipeMock([
      {
        data: {
          id: SKILL_ID,
          is_system: false,
          category: 'skill',
          workspace_id: WORKSPACE_ID,
          created_by: USER_ID,
          visibility: 'personal',
        },
        error: null,
      },
    ])

    const result = (await tools(supabase).update_skill.execute!({ id: SKILL_ID }, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/nothing to update/i)
    expect(captured.update).toBeUndefined()
  })
})

/**
 * The read-only agent tools. They exist because /create-eval (migration 253)
 * opens by reading the prompt it is about to grade, and before these landed
 * there was no chat-side way to read a live-meeting AGENT — the assistant
 * hunted for `get_agent` through search_tools and then wrote its cases against
 * the catalog description instead of the real prompt.
 */
describe('list_agents', () => {
  const AGENT_ROW = {
    id: 'agent-uuid-1',
    name: 'Project Manager',
    slug: 'project-manager',
    icon: '📋',
    description: 'Proposes actions during a live meeting.',
    is_system: true,
    visibility: 'workspace',
  }

  it('returns system + workspace agents as a catalog, without system_prompt', async () => {
    const { supabase } = recipeMock([
      { data: [AGENT_ROW, { ...AGENT_ROW, id: 'agent-uuid-2', is_system: false }], error: null },
    ])

    const result = (await tools(supabase).list_agents.execute!({}, EXEC_OPTS)) as {
      success: boolean
      agents: Array<Record<string, unknown>>
      count: number
    }

    expect(result.success).toBe(true)
    expect(result.count).toBe(2)
    // The list is the cheap half of the list/get split — prompts never ride along.
    for (const agent of result.agents) {
      expect(agent).not.toHaveProperty('system_prompt')
    }
    expect(result.agents.map((a) => a.id)).toEqual(['agent-uuid-1', 'agent-uuid-2'])
  })

  it('surfaces a query failure instead of an empty list', async () => {
    const { supabase } = recipeMock([{ data: null, error: { message: 'boom' } }])

    const result = (await tools(supabase).list_agents.execute!({}, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/boom/)
  })
})

describe('get_agent', () => {
  const FULL_AGENT = {
    id: 'agent-uuid-1',
    name: 'Project Manager',
    slug: 'project-manager',
    category: 'agent',
    system_prompt: '# Project Manager\n\nPropose an action when someone commits to something.',
    model: 'deepseek-v4-flash',
  }

  it('reads one agent in full by id', async () => {
    const { supabase } = recipeMock([{ data: FULL_AGENT, error: null }])

    const result = (await tools(supabase).get_agent.execute!(
      { id: 'agent-uuid-1' },
      EXEC_OPTS,
    )) as { success: boolean; agent: Record<string, unknown> }

    expect(result.success).toBe(true)
    // The whole point: the prompt itself, not the catalog description.
    expect(result.agent.system_prompt).toContain('Propose an action')
    expect(result.agent.model).toBe('deepseek-v4-flash')
  })

  it('reads one agent by name when the user named it instead of pasting an id', async () => {
    const { supabase } = recipeMock([{ data: [FULL_AGENT], error: null }])

    const result = (await tools(supabase).get_agent.execute!(
      { name: 'Project Manager' },
      EXEC_OPTS,
    )) as { success: boolean; agent: Record<string, unknown> }

    expect(result.success).toBe(true)
    expect(result.agent.id).toBe('agent-uuid-1')
  })

  it('flags an ambiguous name rather than silently picking one', async () => {
    const { supabase } = recipeMock([
      { data: [FULL_AGENT, { ...FULL_AGENT, id: 'agent-uuid-2' }], error: null },
    ])

    const result = (await tools(supabase).get_agent.execute!(
      { name: 'Project Manager' },
      EXEC_OPTS,
    )) as { success: boolean; note?: string }

    expect(result.success).toBe(true)
    expect(result.note).toMatch(/more than one/i)
  })

  it('requires an id or a name', async () => {
    const { supabase } = recipeMock([{ data: null, error: null }])

    const result = (await tools(supabase).get_agent.execute!({}, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/id or a name/i)
  })

  it('tells the model this was an AGENT lookup when the id is a skill', async () => {
    // The `.eq('category','agent')` filter means a skill id simply misses. The
    // message has to name the mistake, or the model retries get_agent forever.
    const { supabase } = recipeMock([{ data: null, error: { message: 'no rows' } }])

    const result = (await tools(supabase).get_agent.execute!({ id: SKILL_ID }, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/agent/i)
    expect(result.error).toMatch(/get_skill/)
  })

  it('says AGENT, and points at get_skill, when a name matches nothing', async () => {
    const { supabase } = recipeMock([{ data: [], error: null }])

    const result = (await tools(supabase).get_agent.execute!(
      { name: 'Weekly Planner' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No AGENT named "Weekly Planner"/)
    expect(result.error).toMatch(/get_skill/)
  })
})

// ---------------------------------------------------------------------------
// PostgREST or-filter escaping
// ---------------------------------------------------------------------------

/**
 * PostgREST splits an `or=(...)` group on commas and reads parentheses as
 * nesting, so an agent name containing either turned ONE condition into
 * several malformed ones and the lookup came back as a PGRST100 parse error
 * rather than a result — with the raw driver message handed to the model.
 */
describe('orFilterValue', () => {
  it('quotes a value so a comma cannot split the group', () => {
    expect(orFilterValue('Acme, Inc Sales Coach')).toBe('"Acme, Inc Sales Coach"')
  })

  it('quotes a value so a parenthesis cannot unbalance the group', () => {
    expect(orFilterValue('Ops (EU) Coach')).toBe('"Ops (EU) Coach"')
  })

  it('escapes an embedded quote and backslash so the value cannot close early', () => {
    expect(orFilterValue('The "Big" Coach')).toBe('"The \\"Big\\" Coach"')
    expect(orFilterValue('a\\b')).toBe('"a\\\\b"')
  })
})

describe('get_agent — name lookup filter', () => {
  /** A mock that records the `or()` filters, which the shared recipeMock's
   *  catch-all proxy swallows. */
  function orRecordingMock(rows: unknown[]) {
    const ors: string[] = []
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      or: (f: string) => {
        ors.push(f)
        return chain
      },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve: (r: Result) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    })
    return { supabase: { from: () => chain }, ors }
  }

  it('never interpolates a raw comma into the or group', async () => {
    const { supabase, ors } = orRecordingMock([])

    await tools(supabase).get_agent.execute!({ name: 'Acme, Inc Sales Coach' }, EXEC_OPTS)

    const nameOr = ors.find((f) => f.includes('name.ilike'))!
    expect(nameOr).toBe(
      'name.ilike."Acme, Inc Sales Coach",slug.ilike."Acme, Inc Sales Coach"',
    )
  })

  it('returns an actionable message, not the raw driver error', async () => {
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve: (r: Result) => unknown) =>
        Promise.resolve({
          data: null,
          error: { message: '"failed to parse logic tree (name.ilike.Acme,...)" (line 1, column 12)' },
        }).then(resolve),
    })

    const result = (await tools({ from: () => chain }).get_agent.execute!(
      { name: 'Acme, Inc Sales Coach' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/logic tree/)
    expect(result.error).toMatch(/list_agents/)
  })
})
