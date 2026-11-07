/**
 * Tests for GET /api/account/skills/[id]/export
 *
 * A hoisted requireWorkspace mock + a table-aware fake Supabase whose
 * chainable builder resolves to a per-table fixture and records its `.eq()`
 * filters.
 *
 * What we lock:
 *   - 401 when unauthenticated (auth helper returns a Response).
 *   - happy path: SKILL.md body + the text/markdown + attachment headers, with
 *     context_rules / response_style folded in as prose sections.
 *   - 404 when the id is not a visible skill-category row (foreign non-system /
 *     wrong category → the recipe select returns no row).
 *   - built-in (is_system) skills export even though the caller doesn't own them.
 *   - tenancy + category: the recipe query is filtered by id, category='skill',
 *     and the house-visibility `.or(is_system.eq.true,workspace_id.eq.<ws>)`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

/**
 * Proxy that returns itself for any chained builder method and resolves (via
 * then / single / maybeSingle) to `result`. Records `.eq()` filters so a test
 * can assert tenancy + category scoping.
 */
function chain(
  result: unknown,
  eqRecorder?: Array<[string, unknown]>,
  orRecorder?: string[],
) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      if (prop === 'eq') {
        return (col: string, val: unknown) => {
          eqRecorder?.push([col, val])
          return new Proxy({}, handler)
        }
      }
      if (prop === 'or') {
        return (filter: string) => {
          orRecorder?.push(filter)
          return new Proxy({}, handler)
        }
      }
      return () => new Proxy({}, handler)
    },
  }
  return new Proxy({}, handler)
}

interface FakeOpts {
  recipeData: unknown
  recipeError?: unknown
  eqRecorder?: Array<[string, unknown]>
  orRecorder?: string[]
}

function makeFakeSupabase(opts: FakeOpts) {
  return {
    from: (table: string) => {
      if (table === 'recipe') {
        return chain(
          { data: opts.recipeData, error: opts.recipeError ?? null },
          opts.eqRecorder,
          opts.orRecorder,
        )
      }
      return chain({ data: null, error: null })
    },
  }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

const { GET } = await import('@/app/api/account/skills/[id]/export/route')

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function getReq() {
  return buildRequest({
    url: 'https://dial8.ai/api/account/skills/skill-1/export',
    method: 'GET',
  })
}

function authed(supabase: unknown) {
  return {
    supabase,
    user: { id: 'user-1', email: 'u@dial8.test' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1', role: 'owner' as const },
  }
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
})

describe('GET /api/account/skills/[id]/export', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await GET(getReq(), makeParams('skill-1'))
    expect(res.status).toBe(401)
  })

  it('exports a SKILL.md with the right headers and folded-in config', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      authed(
        makeFakeSupabase({
          recipeData: {
            name: 'Weekly Planner',
            slug: 'weekly-planner',
            description: 'Plans your week',
            system_prompt: 'You plan the week.',
            agent_config: {
              context_rules: ['Always ask about deadlines', ' '],
              response_style: {
                format: 'bullet points',
                tone: 'concise',
                always_cite_sources: true,
              },
            },
          },
        }),
      ),
    )

    const res = await GET(getReq(), makeParams('skill-1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="weekly-planner.SKILL.md"',
    )

    const text = await res.text()
    expect(text).toContain('name: weekly-planner')
    expect(text).toContain('description: Plans your week')
    expect(text).toContain('You plan the week.')
    // context_rules → bullets (blank rule filtered out).
    expect(text).toContain('## Standing instructions')
    expect(text).toContain('- Always ask about deadlines')
    // response_style → prose.
    expect(text).toContain('## Response style')
    expect(text).toContain('Respond in bullet points format.')
    expect(text).toContain('Use a concise tone.')
    expect(text).toContain('Always cite your sources.')
  })

  it('falls back to normalizeSlug(name) when slug is null', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      authed(
        makeFakeSupabase({
          recipeData: {
            name: 'My Cool Skill',
            slug: null,
            description: 'd',
            system_prompt: 'p',
            agent_config: null,
          },
        }),
      ),
    )
    const res = await GET(getReq(), makeParams('skill-1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="my-cool-skill.SKILL.md"',
    )
    const text = await res.text()
    expect(text).toContain('name: my-cool-skill')
    // No config → no folded sections.
    expect(text).not.toContain('## Standing instructions')
    expect(text).not.toContain('## Response style')
  })

  it('returns 404 when the id is not a visible skill-category row', async () => {
    // The route selects recipe WHERE id = :id AND category = 'skill' AND
    // (is_system OR workspace_id = :ws). A wrong-category/invisible row yields no
    // matching row → maybeSingle data null.
    hoisted.requireWorkspace.mockResolvedValueOnce(
      authed(makeFakeSupabase({ recipeData: null })),
    )
    const res = await GET(getReq(), makeParams('skill-1'))
    expect(res.status).toBe(404)
  })

  it('exports a built-in (is_system) skill the caller does not own', async () => {
    // System skills carry is_system=true and a NULL/foreign workspace_id, so the
    // house-visibility `.or(is_system.eq.true,...)` clause lets them through even
    // though workspace_id !== the caller's. Before the fix this 404'd.
    hoisted.requireWorkspace.mockResolvedValueOnce(
      authed(
        makeFakeSupabase({
          recipeData: {
            name: 'Built-in Planner',
            slug: 'built-in-planner',
            description: 'A house skill',
            system_prompt: 'You are a house skill.',
            agent_config: null,
          },
        }),
      ),
    )
    const res = await GET(getReq(), makeParams('skill-1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="built-in-planner.SKILL.md"',
    )
    const text = await res.text()
    expect(text).toContain('You are a house skill.')
  })

  it('still 404s a foreign non-system skill from another workspace', async () => {
    // A non-system row owned by a different workspace fails BOTH sides of the
    // visibility clause (is_system=false AND workspace_id !== caller), so RLS +
    // the `.or()` filter return no row → 404. Modeled by the fixture yielding null.
    hoisted.requireWorkspace.mockResolvedValueOnce(
      authed(makeFakeSupabase({ recipeData: null })),
    )
    const res = await GET(getReq(), makeParams('foreign-skill'))
    expect(res.status).toBe(404)
  })

  it('scopes the recipe query by id, category=skill, and house visibility', async () => {
    const eqRecorder: Array<[string, unknown]> = []
    const orRecorder: string[] = []
    hoisted.requireWorkspace.mockResolvedValueOnce(
      authed(
        makeFakeSupabase({
          recipeData: {
            name: 'S',
            slug: 's',
            description: 'd',
            system_prompt: 'p',
            agent_config: null,
          },
          eqRecorder,
          orRecorder,
        }),
      ),
    )
    const res = await GET(getReq(), makeParams('skill-1'))
    expect(res.status).toBe(200)
    expect(eqRecorder).toEqual(
      expect.arrayContaining([
        ['id', 'skill-1'],
        ['category', 'skill'],
      ]),
    )
    // Workspace scoping now lives in the visibility `.or()` clause, not an `.eq`.
    expect(eqRecorder).not.toContainEqual(['workspace_id', 'workspace-1'])
    expect(orRecorder).toEqual(['is_system.eq.true,workspace_id.eq.workspace-1'])
  })
})
