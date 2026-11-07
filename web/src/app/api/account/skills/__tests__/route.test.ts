/**
 * Tests for slug hygiene on the skills routes (Phase 2 —
 * docs/plans/agents-skills-page-redesign.md §6).
 *
 * The routes route all slug decisions through `ensureUniqueSlug`, so a collision
 * with an existing workspace/system slug no longer 409s — it self-heals to
 * `base-2`, `base-3`, … and the write still succeeds. These tests drive the
 * handler end-to-end with a Supabase fake that seeds the "taken" namespace.
 *
 * The fake serves two terminal styles from one `.from('recipe')`:
 *   - `.single()` — the existing-row fetch (PATCH) and the insert/update result
 *   - awaiting the builder directly — `ensureUniqueSlug`'s namespace read
 *     (`.select().or().not()[.neq()]`), which returns `{ data: takenRows }`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: vi.fn(),
}))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

import { POST } from '@/app/api/account/skills/route'
import { PATCH } from '@/app/api/account/skills/[id]/route'

/** Captures what the handler inserted/updated so tests can assert the slug. */
interface Captured {
  inserted?: Record<string, unknown>
  updated?: Record<string, unknown>
}

/**
 * Build a Supabase fake for the recipe table.
 *
 * @param taken     rows returned by the namespace read (slug collision source)
 * @param existing  the row `.single()` returns for the PATCH existing-row fetch
 *                  and as the insert/update echo (merged with the write payload)
 */
function makeSupabase(
  taken: { id: string; slug: string | null }[],
  existing: Record<string, unknown>,
  captured: Captured,
) {
  function builder(op: 'read' | 'insert' | 'update', payload?: Record<string, unknown>) {
    let neqId: string | undefined
    const b: any = {
      select: () => b,
      eq: () => b,
      or: () => b,
      not: () => b,
      limit: () => b,
      neq: (_col: string, val: string) => {
        neqId = val
        return b
      },
      // Terminal for the existing-row fetch and the insert/update echo.
      single: () => {
        if (op === 'insert') {
          captured.inserted = payload
          return Promise.resolve({ data: { ...existing, ...payload }, error: null })
        }
        if (op === 'update') {
          captured.updated = payload
          return Promise.resolve({ data: { ...existing, ...payload }, error: null })
        }
        return Promise.resolve({ data: existing, error: null })
      },
      // Thenable: awaiting the builder directly resolves the namespace read.
      then: (resolve: (v: { data: unknown }) => unknown) => {
        const data = neqId ? taken.filter((r) => r.id !== neqId) : taken
        return Promise.resolve(resolve({ data }))
      },
    }
    return b
  }
  return {
    from: () => ({
      select: () => builder('read').select(),
      insert: (payload: Record<string, unknown>) => builder('insert', payload),
      update: (payload: Record<string, unknown>) => builder('update', payload),
    }),
  }
}

function memberAuth(
  taken: { id: string; slug: string | null }[],
  existing: Record<string, unknown>,
  captured: Captured,
) {
  return {
    user: { id: 'user-1', email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1', role: 'owner' },
    supabase: makeSupabase(taken, existing, captured),
  }
}

const params = Promise.resolve({ id: 'rec-1' })

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspaceMember.mockReset()
})

describe('skill create — slug hygiene', () => {
  it('derives the slug from the name when none is supplied', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth([], { id: 'rec-1', category: 'skill', visibility: 'workspace' }, captured),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Weekly Planner' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
    expect(captured.inserted?.slug).toBe('weekly-planner')
  })

  it('normalizes an explicitly-supplied slug', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth([], { id: 'rec-1', category: 'skill', visibility: 'workspace' }, captured),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Anything', slug: 'My Cool Slug!' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
    expect(captured.inserted?.slug).toBe('my-cool-slug')
  })

  it('suffixes to base-2 on a collision instead of 409ing', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth(
        [{ id: 'other', slug: 'weekly-planner' }],
        { id: 'rec-1', category: 'skill', visibility: 'workspace' },
        captured,
      ),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Weekly Planner' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
    expect(captured.inserted?.slug).toBe('weekly-planner-2')
  })

  it('rejects a reserved slug with 400 (validateSlug still guards)', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth([], { id: 'rec-1', category: 'skill', visibility: 'workspace' }, captured),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Help', slug: 'help' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(400)
  })
})

describe('skill edit — slug hygiene', () => {
  it('leaves an UNCHANGED slug untouched (no re-slug against itself)', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth(
        [{ id: 'rec-1', slug: 'planner' }],
        { id: 'rec-1', is_system: false, category: 'skill', visibility: 'workspace', slug: 'planner' },
        captured,
      ),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { slug: 'planner', name: 'Renamed' } }) as unknown as NextRequest,
      { params },
    )
    expect(res.status).toBe(200)
    // Slug not in the update payload → left as-is.
    expect(captured.updated).toBeDefined()
    expect('slug' in (captured.updated as object)).toBe(false)
  })

  it('suffixes when edited onto a slug another row already holds', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth(
        [
          { id: 'rec-1', slug: 'planner' },
          { id: 'sibling', slug: 'taken' },
        ],
        { id: 'rec-1', is_system: false, category: 'skill', visibility: 'workspace', slug: 'planner' },
        captured,
      ),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { slug: 'taken' } }) as unknown as NextRequest,
      { params },
    )
    expect(res.status).toBe(200)
    expect(captured.updated?.slug).toBe('taken-2')
  })

  it('lets a row keep editing back to its own current slug value', async () => {
    // Changing away then the client re-sends the same value: excludeId shields self.
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      memberAuth(
        [{ id: 'rec-1', slug: 'planner' }],
        { id: 'rec-1', is_system: false, category: 'skill', visibility: 'workspace', slug: 'old' },
        captured,
      ),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { slug: 'planner' } }) as unknown as NextRequest,
      { params },
    )
    // existing.slug is 'old', requested 'planner' differs → re-slug runs, but the
    // only holder of 'planner' is rec-1 itself (excluded) → stays 'planner'.
    expect(res.status).toBe(200)
    expect(captured.updated?.slug).toBe('planner')
  })
})

describe('skill area (migration 316)', () => {
  const existing = { id: 'rec-1', is_system: false, category: 'skill', visibility: 'workspace', slug: 'planner' }

  it('create stores a valid area', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(memberAuth([], existing, captured))
    const res = await POST(buildRequest({ body: { name: 'Outbound rules', area: 'prospecting' } }) as unknown as NextRequest)
    expect(res.status).toBe(200)
    expect(captured.inserted?.area).toBe('prospecting')
  })

  it('create without an area leaves the column alone', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(memberAuth([], existing, captured))
    await POST(buildRequest({ body: { name: 'Plain' } }) as unknown as NextRequest)
    expect(captured.inserted).toBeDefined()
    expect('area' in (captured.inserted as object)).toBe(false)
  })

  it('refuses an unknown area with a 400 that lists the valid ones, and writes nothing', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(memberAuth([], existing, captured))
    const res = await POST(buildRequest({ body: { name: 'Bad', area: 'inbox' } }) as unknown as NextRequest)
    expect(res.status).toBe(400)
    const body = (await readJson(res)) as { error: string }
    expect(body.error).toContain('area must be one of calendar, actions')
    expect(captured.inserted).toBeUndefined()
  })

  it('edit sets, clears, or leaves the area', async () => {
    for (const [sent, expected] of [['mail', 'mail'], [null, null], ['', null]] as const) {
      const captured: Captured = {}
      hoisted.requireWorkspaceMember.mockResolvedValue(memberAuth([], existing, captured))
      const res = await PATCH(buildRequest({ method: 'PATCH', body: { area: sent } }) as unknown as NextRequest, { params })
      expect(res.status).toBe(200)
      expect(captured.updated?.area).toBe(expected)
    }
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(memberAuth([], existing, captured))
    await PATCH(buildRequest({ method: 'PATCH', body: { name: 'Renamed' } }) as unknown as NextRequest, { params })
    expect('area' in (captured.updated as object)).toBe(false)
  })

  it('edit refuses an unknown area', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(memberAuth([], existing, captured))
    const res = await PATCH(buildRequest({ method: 'PATCH', body: { area: 'Mail' } }) as unknown as NextRequest, { params })
    expect(res.status).toBe(400)
    expect(captured.updated).toBeUndefined()
  })
})
