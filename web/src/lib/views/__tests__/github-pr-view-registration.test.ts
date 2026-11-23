/**
 * Registration invariants for the 'github_pr' views kind (the Reviews page,
 * docs/plans/github-reviews.md): rows read from GitHub, not a table, so the
 * query engine refuses it; board grouping on its stage field; defaults that
 * name real display properties; and the filter pickers' `local:` sources.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOARD_GROUP_BY, DEFAULT_DISPLAY_PROPERTIES, DISPLAY_PROPERTIES, FIELD_CATEGORIES, FILTERABLE_FIELDS } from '@/lib/views/types'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import { BOARD_COLUMNS } from '@/lib/github/reviews'
import { localEnumOptions, setLocalEnumOptions } from '@/lib/views/local-enum-options'

describe('github_pr views registration', () => {
  it('boards on its stage, whose options are the board columns and closed', () => {
    expect(DEFAULT_BOARD_GROUP_BY.github_pr).toBe('board_column')
    const stage = FILTERABLE_FIELDS.github_pr.find((x) => x.field === 'board_column')!
    expect(stage.options).toEqual([...BOARD_COLUMNS, 'closed'])
  })

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.github_pr.map((d) => d.field))
    for (const field of DEFAULT_DISPLAY_PROPERTIES.github_pr) expect(declared.has(field)).toBe(true)
  })

  it('every categorised field is a filterable one', () => {
    const filterable = new Set(FILTERABLE_FIELDS.github_pr.map((x) => x.field))
    for (const cat of FIELD_CATEGORIES.github_pr) for (const field of cat.fields) expect(filterable.has(field)).toBe(true)
  })

  it('has no detail endpoint: a row opens in the Reviews page', () => {
    expect(ENTITY_ENDPOINTS.github_pr({ id: 'acme/app#1' } as never)).toBeNull()
  })

  it('reads the repository, author, assignee and label pickers from the rows on screen', () => {
    for (const field of ['repo', 'author', 'assignees', 'labels']) {
      expect(FILTERABLE_FIELDS.github_pr.find((x) => x.field === field)!.options).toBe(`local:github_pr.${field}`)
    }
    setLocalEnumOptions('github_pr.repo', ['b/b', 'a/a', 'a/a'])
    expect(localEnumOptions('github_pr.repo')).toEqual(['a/a', 'b/b'])
  })
})
