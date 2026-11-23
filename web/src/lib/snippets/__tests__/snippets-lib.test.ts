import { describe, expect, it } from 'vitest'
import { checkSnippetInput, normalizeShortcut, shortcutFromName, snippetPreview, type Snippet } from '../types'
import { filterSnippets } from '../match'
import { findSnippetToken, inMarkdownCode, isSnippetQuery, replaceSnippetToken, snippetPrefixOk } from '../trigger'
import { applyFillIns, fillInsOf, firstNameOf } from '../fill-ins'

const snip = (over: Partial<Snippet>): Snippet => ({
  id: over.shortcut ?? 'x',
  name: 'Snippet',
  shortcut: 'x',
  body: 'Hello',
  visibility: 'personal',
  mine: true,
  canEdit: true,
  updatedAt: '2026-11-23T00:00:00Z',
  ...over,
})

describe('findSnippetToken', () => {
  const at = (text: string) => findSnippetToken(text.replace('|', ''), text.indexOf('|'))

  it('opens at the start of the text, a line or a word', () => {
    expect(at(';|')).toEqual({ start: 0, caret: 1, query: '' })
    expect(at(';sig|')).toEqual({ start: 0, caret: 4, query: 'sig' })
    expect(at('Thanks ;sig|')).toEqual({ start: 7, caret: 11, query: 'sig' })
    expect(at('Line one\n;fo|')).toMatchObject({ query: 'fo' })
    expect(at('(;fo|')).toMatchObject({ query: 'fo' })
    expect(at('Use ;follow-up_2|')).toMatchObject({ query: 'follow-up_2' })
  })

  it('does not open mid-word or after punctuation', () => {
    expect(at('a;b|')).toBeNull()
    expect(at('x;|')).toBeNull()
    expect(at('one, two;|')).toBeNull()
    expect(at('https://a.example/x;y|')).toBeNull()
  })

  it('does not open with a word going on after the caret', () => {
    expect(at(';si|g')).toBeNull()
    expect(at(';sig| and more')).toMatchObject({ query: 'sig' })
  })

  it('a space or a long query ends it', () => {
    expect(at('; |')).toBeNull()
    expect(at(`;${'a'.repeat(33)}|`)).toBeNull()
    expect(at(`;${'a'.repeat(32)}|`)).not.toBeNull()
  })

  it('does not open inside code', () => {
    expect(at('`code ;x|')).toBeNull()
    expect(at('`a` ;x|')).toMatchObject({ query: 'x' })
    expect(at('```\nlet a\n;x|')).toBeNull()
    expect(at('```\nlet a\n```\n;x|')).toMatchObject({ query: 'x' })
  })

  it('does not open inside a link address', () => {
    expect(at('[docs](https://a.example/ ;x|')).toBeNull()
    expect(at('[docs](https://a.example/) ;x|')).toMatchObject({ query: 'x' })
  })

  it('replaces the token with the text', () => {
    const value = 'Hi ;sig there'
    const token = findSnippetToken(value, 7)!
    expect(replaceSnippetToken(value, token, 'Best,\nMaya')).toEqual({ value: 'Hi Best,\nMaya there', caret: 13 })
  })

  it('helpers', () => {
    expect(isSnippetQuery('ab-c_1')).toBe(true)
    expect(isSnippetQuery('a b')).toBe(false)
    expect(snippetPrefixOk(undefined)).toBe(true)
    expect(snippetPrefixOk(' ')).toBe(true)
    expect(snippetPrefixOk('a')).toBe(false)
    expect(inMarkdownCode('x `y', 4)).toBe(true)
  })
})

describe('filterSnippets', () => {
  const list = [
    snip({ shortcut: 'sig', name: 'Signature' }),
    snip({ shortcut: 'followup', name: 'Meeting follow-up', body: 'Thanks for the call today' }),
    snip({ shortcut: 'sig', name: 'Team signature', visibility: 'workspace', mine: false }),
    snip({ shortcut: 'pricing', name: 'Pricing answer', visibility: 'workspace' }),
  ]

  it('lists all for an empty query, personal first', () => {
    expect(filterSnippets(list, '').map((s) => `${s.shortcut}:${s.visibility}`)).toEqual([
      'followup:personal',
      'sig:personal',
      'pricing:workspace',
      'sig:workspace',
    ])
  })

  it('ranks shortcut prefix, then name words, then body', () => {
    expect(filterSnippets(list, 'si').map((s) => s.name)).toEqual(['Signature', 'Team signature'])
    expect(filterSnippets(list, 'meet').map((s) => s.shortcut)).toEqual(['followup'])
    expect(filterSnippets(list, 'call').map((s) => s.shortcut)).toEqual(['followup'])
    expect(filterSnippets(list, 'zz')).toEqual([])
    expect(filterSnippets(list, 'SIG')).toHaveLength(2)
  })
})

describe('snippet input', () => {
  it('normalizes shortcuts', () => {
    expect(normalizeShortcut(';Follow Up!')).toBe('follow-up')
    expect(normalizeShortcut('--x')).toBe('x')
    expect(shortcutFromName('Café hours')).toBe('cafe-hours')
  })

  it('checks a create and a change', () => {
    expect(checkSnippetInput({ name: 'Sig', shortcut: 'Sig', body: 'Best' }, false)).toEqual({
      ok: true,
      value: { name: 'Sig', shortcut: 'sig', body: 'Best', visibility: 'personal' },
    })
    expect(checkSnippetInput({ name: '', shortcut: 's', body: 'b' }, false).ok).toBe(false)
    expect(checkSnippetInput({ name: 'n', shortcut: '!!', body: 'b' }, false).ok).toBe(false)
    expect(checkSnippetInput({ name: 'n', shortcut: 's', body: '  ' }, false).ok).toBe(false)
    expect(checkSnippetInput({ visibility: 'public' }, true).ok).toBe(false)
    expect(checkSnippetInput({ body: 'New words  \n' }, true)).toEqual({ ok: true, value: { body: 'New words' } })
  })

  it('previews the first line as words', () => {
    expect(snippetPreview('## **Hello** [there](https://x.example)\nmore')).toBe('Hello there')
    expect(snippetPreview('- [ ] item')).toBe('item')
    expect(snippetPreview('Hi {{first_name}}, _thanks_')).toBe('Hi {{first_name}}, thanks')
    expect(snippetPreview('x'.repeat(200), 10)).toHaveLength(10)
  })
})

describe('fill-ins', () => {
  const now = new Date(2026, 10, 23, 15, 5)
  it('fills what is known and leaves the rest', () => {
    const body = 'Hi {{first_name}}, on {{ date }} — {{my_first_name}} ({{unknown}}) {single}'
    expect(applyFillIns(body, { now, locale: 'en-US', me: { name: 'Rosa Lind' }, recipient: { name: 'Maya Chen' } })).toBe(
      'Hi Maya, on November 23, 2026 — Rosa ({{unknown}}) {single}',
    )
    expect(applyFillIns(body, { now, locale: 'en-US' })).toBe('Hi {{first_name}}, on November 23, 2026 — {{my_first_name}} ({{unknown}}) {single}')
  })

  it('reads first names', () => {
    expect(firstNameOf({ name: 'Chen, Maya' })).toBe('Maya')
    expect(firstNameOf({ email: 'maya.chen@example.com' })).toBe('Maya')
    expect(firstNameOf({ email: 'info2@example.com' })).toBeNull()
    expect(firstNameOf(null)).toBeNull()
  })

  it('lists the fill-ins a body holds', () => {
    expect(fillInsOf('{{date}} {{name}} {{date}} {{nope}}')).toEqual(['date', 'name'])
  })
})
