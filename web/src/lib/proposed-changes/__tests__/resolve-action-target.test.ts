/**
 * Tests for fuzzy action-target resolution.
 *
 * Live bug (observed 2026-07-01): the extractor stages update:action proposals
 * with entity_id=null essentially always (11/11 pending updates in one
 * workspace, 25/25 in another), and the apply engine hard-failed every one
 * with "Entity ID required for action update". The resolver matches the
 * proposal's descriptive text against existing actions so updates become
 * appliable — refusing (null) when the match would be a guess.
 */
import { describe, it, expect, vi } from 'vitest'
import { findBestActionMatch, resolveActionTarget } from '../resolve-action-target'

describe('findBestActionMatch', () => {
  const candidates = [
    { id: 'a1', title: 'Update API docs', identifier: 'ENG-1' },
    { id: 'a2', title: 'Fix login redirect loop', identifier: 'ENG-2' },
    { id: 'a3', title: 'Prepare Q3 board deck', identifier: 'ENG-3' },
  ]

  it('matches a spoken identifier above everything else', () => {
    const { match } = findBestActionMatch(candidates, [
      'Bump the priority',
      'Move ENG-3 to urgent because the board meeting moved up',
    ])
    expect(match?.id).toBe('a3')
  })

  it('matches an exact title ignoring case and punctuation', () => {
    const { match } = findBestActionMatch(candidates, ['update api docs!'])
    expect(match?.id).toBe('a1')
  })

  it('matches by containment when the needle carries extra words', () => {
    const { match } = findBestActionMatch(candidates, [
      'Sarah to fix login redirect loop by Friday',
    ])
    expect(match?.id).toBe('a2')
  })

  it('matches by significant-token overlap across word-order changes', () => {
    const { match } = findBestActionMatch(candidates, [
      'the board deck for Q3 needs new numbers',
    ])
    expect(match?.id).toBe('a3')
  })

  it('prefers the title needle over display_text when both are given', () => {
    const { match } = findBestActionMatch(candidates, [
      'Update API docs',
      'Liam to prepare the Q3 board deck',
    ])
    expect(match?.id).toBe('a1')
  })

  it('refuses when two candidates match equally well (ambiguous)', () => {
    const twins = [
      { id: 'b1', title: 'Update API docs for v1' },
      { id: 'b2', title: 'Update API docs for v2' },
    ]
    const result = findBestActionMatch(twins, ['update API docs'])
    expect(result.match).toBeNull()
    expect(result.ambiguous).toBe(true)
  })

  it('does not match on trivially short or stopword-only overlap', () => {
    const { match, ambiguous } = findBestActionMatch(candidates, ['fix it'])
    expect(match).toBeNull()
    expect(ambiguous).toBe(false)
  })

  it('returns no match for unrelated text', () => {
    const { match } = findBestActionMatch(candidates, [
      'Schedule the offsite venue walkthrough',
    ])
    expect(match).toBeNull()
  })

  it('handles empty needles and empty candidate pools', () => {
    expect(findBestActionMatch(candidates, [null, undefined, '']).match).toBeNull()
    expect(findBestActionMatch([], ['Update API docs']).match).toBeNull()
  })
})

// ─── resolveActionTarget (candidate pool + scoping) ──────────────────────────

type ActionRow = {
  id: string
  title: string
  identifier: string
  project_id: string | null
  team_id: string | null
  workflow_state: { category: string } | null
}

/** Chainable stub: any select chain on `actions` resolves to the given rows. */
function makeSupabase(rows: ActionRow[]) {
  const chain: Record<string, unknown> = {}
  const proxy: Record<string, unknown> = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve)
      }
      return () => proxy
    },
  })
  return { from: vi.fn(() => proxy) }
}

function row(overrides: Partial<ActionRow> & { id: string; title: string }): ActionRow {
  return {
    identifier: 'ENG-0',
    project_id: null,
    team_id: null,
    workflow_state: { category: 'unstarted' },
    ...overrides,
  }
}

describe('resolveActionTarget', () => {
  it('resolves a target from the workspace pool', async () => {
    const supabase = makeSupabase([
      row({ id: 'a1', title: 'Update API docs', identifier: 'ENG-1' }),
      row({ id: 'a2', title: 'Fix login redirect loop', identifier: 'ENG-2' }),
    ])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      title: 'Update API docs',
    })
    expect(target).toMatchObject({ id: 'a1', identifier: 'ENG-1' })
  })

  it('excludes completed and canceled actions from the pool', async () => {
    const supabase = makeSupabase([
      row({ id: 'done', title: 'Update API docs', workflow_state: { category: 'completed' } }),
      row({ id: 'dead', title: 'Update API docs', workflow_state: { category: 'canceled' } }),
    ])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      title: 'Update API docs',
    })
    expect(target).toBeNull()
  })

  it('keeps actions with no workflow state (null status) in the pool', async () => {
    const supabase = makeSupabase([
      row({ id: 'a1', title: 'Update API docs', workflow_state: null }),
    ])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      title: 'Update API docs',
    })
    expect(target?.id).toBe('a1')
  })

  it('a project-scoped match wins over an identical title elsewhere', async () => {
    // Globally this title is ambiguous (two identical matches) — the project
    // scope disambiguates to the capture's own action.
    const supabase = makeSupabase([
      row({ id: 'other', title: 'Update API docs' }),
      row({ id: 'mine', title: 'Update API docs', project_id: 'proj-1' }),
    ])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      title: 'Update API docs',
      projectId: 'proj-1',
    })
    expect(target?.id).toBe('mine')
  })

  it('returns null when the match is ambiguous even with scoping', async () => {
    const supabase = makeSupabase([
      row({ id: 'b1', title: 'Update API docs for v1', team_id: 'team-1' }),
      row({ id: 'b2', title: 'Update API docs for v2', team_id: 'team-1' }),
    ])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      title: 'Update API docs',
      teamId: 'team-1',
    })
    expect(target).toBeNull()
  })

  it('returns null without querying when there is no descriptive text', async () => {
    const supabase = makeSupabase([row({ id: 'a1', title: 'Update API docs' })])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      title: null,
      displayText: '  ',
    })
    expect(target).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('falls back to display_text when title is missing', async () => {
    const supabase = makeSupabase([
      row({ id: 'a2', title: 'Fix login redirect loop', identifier: 'ENG-2' }),
    ])
    const target = await resolveActionTarget(supabase as never, 'ws-1', {
      displayText: 'Mark fix login redirect loop as done',
    })
    expect(target?.id).toBe('a2')
  })
})
