/**
 * The shortcut registry (lib/shortcuts.ts) is coherent: no two shortcuts fire
 * on the same keys, no shortcut takes a key the browser, the OS or the
 * desktop app keeps, and every `/` page has its own G then a letter.
 */
import { describe, expect, it } from 'vitest'
import {
  GO_TO,
  GO_TO_PREFIX,
  PAGES_WITHOUT_GO_TO,
  SHORTCUTS,
  findShortcutConflicts,
  goToFor,
  keysText,
  normalizeKeys,
  type ShortcutDef,
} from '../shortcuts'
import { CARD_PAGES } from '../chat-cards/page-menu'
import { PAGE_GROUPS } from '@/app/account/(dashboard)/rail/page-groups'
import { RAIL_PAGES } from '@/app/account/(dashboard)/rail/rail-pages'

describe('the shortcut registry', () => {
  it('has no conflicts', () => {
    expect(findShortcutConflicts()).toEqual([])
  })

  it('catches two shortcuts on the same keys where both can fire', () => {
    const extra: ShortcutDef = { id: 'x', keys: ['shift+mod+k'], label: 'X', section: 'General', scope: 'mail' }
    const clash: ShortcutDef = { id: 'y', keys: ['mod+shift+k'], label: 'Y', section: 'General', scope: 'global' }
    expect(findShortcutConflicts([extra, clash], [])).toEqual([{ keys: 'mod+shift+k', ids: ['x', 'y'], why: 'same keys' }])
  })

  it('lets two pages use the same key, and a page stand in for an app-wide key only when it says so', () => {
    const mail: ShortcutDef = { id: 'm', keys: ['j'], label: 'M', section: 'Mail', scope: 'mail' }
    const panel: ShortcutDef = { id: 'p', keys: ['j'], label: 'P', section: 'General', scope: 'palette' }
    expect(findShortcutConflicts([mail, panel], [])).toEqual([])
    const create: ShortcutDef = { id: 'create', keys: ['c'], label: 'Create', section: 'General', scope: 'global' }
    const compose: ShortcutDef = { id: 'compose', keys: ['c'], label: 'Compose', section: 'Mail', scope: 'mail' }
    expect(findShortcutConflicts([create, compose], [])).toHaveLength(1)
    expect(findShortcutConflicts([create, { ...compose, overrides: 'create' }], [])).toEqual([])
  })

  it('refuses a bare key that starts a sequence, and a reserved key', () => {
    const bareG: ShortcutDef = { id: 'g', keys: ['g'], label: 'G', section: 'General', scope: 'mail' }
    expect(findShortcutConflicts([...SHORTCUTS, bareG]).some((c) => c.ids.includes('g') && c.why === 'one starts the other')).toBe(true)
    const find: ShortcutDef = { id: 'find', keys: ['mod+f'], label: 'Find', section: 'General', scope: 'mail' }
    expect(findShortcutConflicts([find])).toEqual([{ keys: 'mod+f', ids: ['find', 'find'], why: 'kept by the browser, the OS or the desktop app' }])
  })

  it('gives every `/` page a go-to: its own, or (an SEO section) its group’s', () => {
    const own = new Set(GO_TO.flatMap((g) => (g.target.type === 'page' ? [g.target.slug] : [])))
    const groups = new Set(GO_TO.flatMap((g) => (g.target.type === 'group' ? PAGE_GROUPS[g.target.id].members : [])))
    const missing = CARD_PAGES.map((p) => p.slug).filter((slug) => !own.has(slug) && !groups.has(slug))
    // The alphabet is full: the pages left without a letter are named in the registry, not forgotten.
    expect(missing).toEqual([...PAGES_WITHOUT_GO_TO])
    // And the day a letter frees up, the list has to shrink: no page is both listed and reachable.
    expect(PAGES_WITHOUT_GO_TO.filter((slug) => own.has(slug) || groups.has(slug))).toEqual([])
    expect(new Set(GO_TO.map((g) => g.letter)).size).toBe(25)
    // Each go-to page is a real `/` page.
    const slugs = new Set(CARD_PAGES.map((p) => p.slug))
    expect([...own].filter((s) => !slugs.has(s))).toEqual([])
  })

  it('gives every rail icon a go-to for its tooltip', () => {
    for (const def of RAIL_PAGES) {
      expect(goToFor({ group: def.id }) ?? goToFor({ slug: def.slug }), def.id).not.toBeNull()
    }
    expect(goToFor({ home: true })?.letter).toBe('h')
  })

  it('uses one letter a–z per go-to, never G itself, and the owner’s G M, G C, G H', () => {
    const letters = GO_TO.map((g) => g.letter)
    expect(new Set(letters).size).toBe(letters.length)
    expect(letters.every((l) => /^[a-z]$/.test(l) && l !== GO_TO_PREFIX)).toBe(true)
    expect(goToFor({ slug: 'mail' })?.letter).toBe('m')
    expect(goToFor({ slug: 'calendar' })?.letter).toBe('c')
    expect(goToFor({ slug: 'projects' })?.letter).toBe('p')
  })

  it('writes keys for people', () => {
    expect(keysText('g m', true)).toBe('G then M')
    expect(keysText('mod+k', true)).toBe('⌘K')
    expect(keysText('mod+k', false)).toBe('Ctrl+K')
    expect(keysText('shift+h', true)).toBe('⇧H')
    expect(normalizeKeys('Shift+Mod+K')).toBe('mod+shift+k')
  })
})
