/**
 * The library's rows on the shared list (docs/plans/views-everywhere.md): a
 * row's right-click offers what its hover buttons did. Open always; Add on a
 * Discover listing that is someone else's; Edit and Delete on what the person
 * may manage (never a built-in, nor another's Discover listing).
 */
import { describe, expect, it, vi } from 'vitest'
import { libraryRowMenu, type LibraryListRow } from '../library-list'

const row = (over: Partial<LibraryListRow>): LibraryListRow =>
  ({ id: 'r1', name: 'Weekly digest', is_system: false, library_scope: 'mine', is_mine: true, ...over }) as LibraryListRow
const act = { onView: vi.fn(), onEdit: vi.fn(), onFork: vi.fn(), onDelete: vi.fn() }
const keys = (r: LibraryListRow, forking: string | null = null) => libraryRowMenu(r, forking, act).map((m) => m.key)

describe('a library row’s menu', () => {
  it('one’s own item: open, edit, delete', () => {
    expect(keys(row({}))).toEqual(['open', 'edit', 'delete'])
  })
  it('a built-in: open only', () => {
    expect(keys(row({ is_system: true }))).toEqual(['open'])
  })
  it('someone else’s Discover listing: open and add (Adding… while it is added)', () => {
    expect(keys(row({ library_scope: 'discover', is_mine: false }))).toEqual(['open', 'add'])
    expect(libraryRowMenu(row({ library_scope: 'discover', is_mine: false }), 'r1', act)[1].label).toBe('Adding…')
  })
  it('one’s own Discover listing: open, edit, delete; no add', () => {
    expect(keys(row({ library_scope: 'discover', is_mine: true }))).toEqual(['open', 'edit', 'delete'])
  })
  it('each item runs its own verb', () => {
    const r = row({})
    libraryRowMenu(r, null, act).find((m) => m.key === 'delete')!.onSelect()
    expect(act.onDelete).toHaveBeenCalledWith(r)
  })
})
