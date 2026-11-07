import { describe, it, expect } from 'vitest'
import {
  workspaceIdSet,
  forkedFromSet,
  myIdSet,
  dedupeAll,
  filterDiscover,
  itemsForScope,
  filterByType,
  matchesSearch,
  filterBySearch,
  selectDisplayedItems,
  selectLibraryViewItems,
  type LibrarySources,
} from '../library-filter'
import type { LibraryRow } from '../library-types'
import type { LibraryScope, ViewFilter } from '@/lib/views/types'

/** Minimal row factory — only the fields the filter logic reads must be real. */
function row(overrides: Partial<LibraryRow> & { id: string }): LibraryRow {
  return {
    name: overrides.name ?? `Item ${overrides.id}`,
    icon: null,
    color: null,
    description: null,
    category: 'skill',
    slug: null,
    is_system: false,
    is_default: false,
    visibility: 'workspace',
    created_by: null,
    fork_count: 0,
    forked_from: null,
    author_name: null,
    author_avatar_url: null,
    marketplace_category: null,
    featured: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('shared library views', () => {
  const builtin = row({ id: 'builtin', category: 'agent', is_system: true })
  const installed = row({ id: 'installed', category: 'agent', forked_from: 'template' })
  const own = row({ id: 'own', name: 'Research', category: 'agent', visibility: 'public' })
  const personal = row({ id: 'personal', name: 'Private', category: 'agent', visibility: 'personal' })
  const publicAgent = row({ id: 'public', name: 'Public research', category: 'agent', visibility: 'public' })
  const sources: LibrarySources = {
    workspace: [builtin, installed, own],
    mine: [personal, own],
    discover: [builtin, own, row({ id: 'template', category: 'agent' }), publicAgent, row({ id: 'skill' })],
  }
  const collection = (scope: LibraryScope): ViewFilter => ({ id: 'collection', field: 'library_scope', operator: 'is', value: scope })

  it.each(['all', 'mine', 'workspace', 'discover'] as const)('%s preserves the old membership, dedupe, search and ordering', scope => {
    for (const query of ['', 'research']) {
      expect(selectLibraryViewItems(sources, 'agent', query, [collection(scope)], []))
        .toEqual(selectDisplayedItems(sources, scope, 'agent', query))
    }
  })

  it('combines collections without duplicating own listings or showing previously installed templates', () => {
    const combined: ViewFilter = { ...collection('all'), operator: 'is_any_of', value: ['mine', 'discover'] }
    const ids = selectLibraryViewItems(sources, 'agent', '', [combined], []).map(r => r.id)
    expect(ids).toEqual(['own', 'personal', 'public'])
  })

  it('applies custom filters and ordering without mutating the source lists', () => {
    const filter: ViewFilter = { id: 'name', field: 'name', operator: 'contains', value: 'RESEARCH' }
    expect(selectLibraryViewItems(sources, 'agent', '', [collection('discover'), filter], [{ field: 'name', direction: 'asc' }]).map(r => r.id))
      .toEqual(['public', 'own'])
    expect(sources.discover.map(r => r.id)).toEqual(['builtin', 'own', 'template', 'public', 'skill'])
  })

  it('treats an unfinished filter as a draft and supports nullable text fields', () => {
    const incomplete: ViewFilter = { id: 'description', field: 'description', operator: 'contains', value: '' }
    expect(selectLibraryViewItems(sources, 'agent', '', [collection('mine'), incomplete], []).map(r => r.id)).toEqual(['personal', 'own'])
    expect(selectLibraryViewItems(sources, 'agent', '', [{ ...incomplete, operator: 'is_not_empty' }], [])).toEqual([])
  })
})

describe('identity sets', () => {
  it('workspaceIdSet collects every workspace row id', () => {
    const set = workspaceIdSet([row({ id: 'a' }), row({ id: 'b' })])
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('forkedFromSet collects only non-null forked_from originals', () => {
    const set = forkedFromSet([
      row({ id: 'copy1', forked_from: 'orig1' }),
      row({ id: 'own', forked_from: null }),
      row({ id: 'copy2', forked_from: 'orig2' }),
    ])
    expect(set).toEqual(new Set(['orig1', 'orig2']))
  })

  it('myIdSet collects every mine row id', () => {
    const set = myIdSet([row({ id: 'm1' }), row({ id: 'm2' })])
    expect(set).toEqual(new Set(['m1', 'm2']))
  })
})

describe('dedupeAll', () => {
  it('merges workspace + mine and removes duplicates by id', () => {
    const workspace = [row({ id: 'shared' }), row({ id: 'ws-only' })]
    const mine = [row({ id: 'shared' }), row({ id: 'personal' })]
    const merged = dedupeAll(workspace, mine)
    expect(merged.map((r) => r.id)).toEqual(['shared', 'ws-only', 'personal'])
  })

  it('keeps the workspace copy when an id appears in both (workspace first)', () => {
    const workspace = [row({ id: 'x', name: 'From Workspace' })]
    const mine = [row({ id: 'x', name: 'From Mine' })]
    const merged = dedupeAll(workspace, mine)
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe('From Workspace')
  })

  it('returns an empty list when both sources are empty', () => {
    expect(dedupeAll([], [])).toEqual([])
  })
})

describe('filterDiscover dedupe rules', () => {
  it('hides an item already installed in the workspace', () => {
    const discover = [row({ id: 'sys' }), row({ id: 'fresh' })]
    const result = filterDiscover(
      discover,
      new Set(['sys']),
      new Set(),
      new Set(),
    )
    expect(result.map((r) => r.id)).toEqual(['fresh'])
  })

  it('hides an item the user previously forked (matched via forked_from)', () => {
    // The public template is 'orig'; the workspace holds a fork whose
    // forked_from is 'orig'. 'orig' must not reappear in Discover.
    const discover = [row({ id: 'orig' }), row({ id: 'other' })]
    const result = filterDiscover(
      discover,
      new Set(), // fork lives under a new id, so not in the workspace-id set
      new Set(['orig']),
      new Set(),
    )
    expect(result.map((r) => r.id)).toEqual(['other'])
  })

  it("always shows the user's own published items even if in the workspace set", () => {
    // A user who published their own item should still see it on Discover to
    // confirm the publish worked — even though its id is in their workspace.
    const discover = [row({ id: 'own-published' })]
    const result = filterDiscover(
      discover,
      new Set(['own-published']),
      new Set(['own-published']),
      new Set(['own-published']),
    )
    expect(result.map((r) => r.id)).toEqual(['own-published'])
  })

  it('own-item exception takes priority over both hide rules', () => {
    const discover = [
      row({ id: 'mine-installed' }),
      row({ id: 'someone-else' }),
    ]
    const result = filterDiscover(
      discover,
      new Set(['mine-installed', 'someone-else']),
      new Set(),
      new Set(['mine-installed']),
    )
    // mine-installed shows (own exception); someone-else hidden (installed).
    expect(result.map((r) => r.id)).toEqual(['mine-installed'])
  })
})

describe('itemsForScope', () => {
  const sources: LibrarySources = {
    discover: [row({ id: 'pub1' }), row({ id: 'installed' })],
    workspace: [row({ id: 'installed' }), row({ id: 'ws' })],
    mine: [row({ id: 'ws' }), row({ id: 'personal' })],
  }

  it('all = deduped workspace ∪ mine', () => {
    expect(itemsForScope('all', sources).map((r) => r.id)).toEqual([
      'installed',
      'ws',
      'personal',
    ])
  })

  it('mine passes through the mine list', () => {
    expect(itemsForScope('mine', sources).map((r) => r.id)).toEqual([
      'ws',
      'personal',
    ])
  })

  it('workspace passes through the workspace list', () => {
    expect(itemsForScope('workspace', sources).map((r) => r.id)).toEqual([
      'installed',
      'ws',
    ])
  })

  it('discover applies its dedupe (hides installed)', () => {
    expect(itemsForScope('discover', sources).map((r) => r.id)).toEqual(['pub1'])
  })
})

describe('filterByType', () => {
  it('keeps only rows of the given category', () => {
    const rows = [
      row({ id: 'a', category: 'agent' }),
      row({ id: 's', category: 'skill' }),
      row({ id: 'a2', category: 'agent' }),
    ]
    expect(filterByType(rows, 'agent').map((r) => r.id)).toEqual(['a', 'a2'])
    expect(filterByType(rows, 'skill').map((r) => r.id)).toEqual(['s'])
  })
})

describe('matchesSearch', () => {
  it('matches on name (case-insensitive)', () => {
    expect(matchesSearch(row({ id: '1', name: 'Weekly Planner' }), 'planner')).toBe(true)
  })

  it('matches on description', () => {
    const r = row({ id: '1', name: 'X', description: 'drafts follow-up emails' })
    expect(matchesSearch(r, 'follow-up')).toBe(true)
  })

  it('matches on slug so /command search works', () => {
    const r = row({ id: '1', name: 'Planner', slug: 'plan-week' })
    expect(matchesSearch(r, 'plan-week')).toBe(true)
  })

  it('returns true for an empty or whitespace query', () => {
    expect(matchesSearch(row({ id: '1' }), '')).toBe(true)
    expect(matchesSearch(row({ id: '1' }), '   ')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    const r = row({ id: '1', name: 'Alpha', description: 'beta', slug: 'gamma' })
    expect(matchesSearch(r, 'delta')).toBe(false)
  })

  it('does not throw on null description/slug', () => {
    const r = row({ id: '1', name: 'Only Name', description: null, slug: null })
    expect(matchesSearch(r, 'zzz')).toBe(false)
    expect(matchesSearch(r, 'only')).toBe(true)
  })
})

describe('filterBySearch', () => {
  it('filters a list down to matching rows', () => {
    const rows = [
      row({ id: '1', name: 'Planner' }),
      row({ id: '2', name: 'Emailer' }),
    ]
    expect(filterBySearch(rows, 'plan').map((r) => r.id)).toEqual(['1'])
  })
})

describe('selectDisplayedItems (full pipeline)', () => {
  const sources: LibrarySources = {
    discover: [
      row({ id: 'pub-agent', category: 'agent', name: 'Community PM' }),
      row({ id: 'installed', category: 'skill' }),
    ],
    workspace: [
      row({ id: 'installed', category: 'skill', name: 'Installed Skill' }),
      row({ id: 'ws-agent', category: 'agent', name: 'Workspace Agent' }),
    ],
    mine: [
      row({ id: 'ws-agent', category: 'agent', name: 'Workspace Agent' }),
      row({ id: 'my-skill', category: 'skill', name: 'My Skill' }),
    ],
  }

  it('all + agent = deduped agents across workspace/mine', () => {
    const out = selectDisplayedItems(sources, 'all', 'agent', '')
    expect(out.map((r) => r.id)).toEqual(['ws-agent'])
  })

  it('all + skill = deduped skills', () => {
    const out = selectDisplayedItems(sources, 'all', 'skill', '')
    expect(out.map((r) => r.id)).toEqual(['installed', 'my-skill'])
  })

  it('discover + agent applies dedupe then type filter', () => {
    const out = selectDisplayedItems(sources, 'discover', 'agent', '')
    // installed skill is hidden by dedupe AND filtered by type; pub-agent shows.
    expect(out.map((r) => r.id)).toEqual(['pub-agent'])
  })

  it('mine + skill + search narrows to matching rows', () => {
    const out = selectDisplayedItems(sources, 'mine', 'skill', 'my')
    expect(out.map((r) => r.id)).toEqual(['my-skill'])
  })

  it('search that matches nothing yields an empty list', () => {
    const out = selectDisplayedItems(sources, 'all', 'agent', 'nonexistent')
    expect(out).toEqual([])
  })
})
