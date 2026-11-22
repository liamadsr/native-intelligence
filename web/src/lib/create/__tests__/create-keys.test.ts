import { describe, it, expect } from 'vitest'
import { CREATE_LETTERS, OPENING_ECHO_MS, composerKeyIntent, createTypeForLetter, isCreateLetterKey, isOpeningKeyEcho } from '../create-keys'
import { CREATE_TYPES } from '../create-types'
import { SEQUENCE_MS } from '@/lib/hotkeys'

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...mods,
})

describe('C then a letter', () => {
  it('gives every letter to one type, and only to types that exist', () => {
    const letters = Object.values(CREATE_LETTERS)
    expect(new Set(letters).size).toBe(letters.length)
    for (const l of letters) expect(l).toMatch(/^[a-z]$/)
    const ids = new Set(CREATE_TYPES.map((t) => t.id))
    for (const id of Object.keys(CREATE_LETTERS)) expect(ids.has(id as never)).toBe(true)
  })

  it('covers the everyday types', () => {
    for (const id of ['action', 'project', 'document', 'table', 'spreadsheet', 'canvas', 'contact', 'company', 'event'] as const) {
      expect(CREATE_LETTERS[id]).toBeTruthy()
    }
  })

  it('finds a letter’s type among those on offer only', () => {
    expect(createTypeForLetter('A', ['action', 'project'])).toBe('action')
    expect(createTypeForLetter('n', ['action'])).toBeNull()
    expect(createTypeForLetter('ab', ['action'])).toBeNull()
  })

  it('reads a letter only first, soon after opening, with nothing typed', () => {
    const openedAt = 1_000
    expect(isCreateLetterKey(key('a'), { search: '', openedAt, now: openedAt + 200 })).toBe(true)
    expect(isCreateLetterKey(key('a'), { search: 'd', openedAt, now: openedAt + 200 })).toBe(false)
    expect(isCreateLetterKey(key('a'), { search: '', openedAt, now: openedAt + SEQUENCE_MS + 1 })).toBe(false)
    expect(isCreateLetterKey(key('a', { shiftKey: true }), { search: '', openedAt, now: openedAt })).toBe(false)
    expect(isCreateLetterKey(key('a', { metaKey: true }), { search: '', openedAt, now: openedAt })).toBe(false)
    expect(isCreateLetterKey(key('1'), { search: '', openedAt, now: openedAt })).toBe(false)
  })
})

describe('the C that opened the menu', () => {
  it('is not a search when the browser types it into the search at once', () => {
    expect(isOpeningKeyEcho('c', 1_000, 1_050)).toBe(true)
    expect(isOpeningKeyEcho('C', 1_000, 1_050)).toBe(true)
    expect(isOpeningKeyEcho('c', 1_000, 1_000 + OPENING_ECHO_MS + 1)).toBe(false)
    expect(isOpeningKeyEcho('ca', 1_000, 1_050)).toBe(false)
  })
})

describe('a composer’s keys', () => {
  it('↵ in the title creates and opens; ⌘/Ctrl ↵ anywhere creates another', () => {
    expect(composerKeyIntent(key('Enter'), 'title')).toBe('create-open')
    expect(composerKeyIntent(key('Enter'), 'other')).toBeNull()
    expect(composerKeyIntent(key('Enter', { metaKey: true }), 'other')).toBe('create-another')
    expect(composerKeyIntent(key('Enter', { ctrlKey: true }), 'title')).toBe('create-another')
  })

  it('leaves ⇧↵, an IME’s ↵ and other keys alone', () => {
    expect(composerKeyIntent(key('Enter', { shiftKey: true }), 'title')).toBeNull()
    expect(composerKeyIntent(key('Enter', { isComposing: true }), 'title')).toBeNull()
    expect(composerKeyIntent(key('a'), 'title')).toBeNull()
  })
})
