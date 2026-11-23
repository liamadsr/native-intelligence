import { describe, expect, it } from 'vitest'
import { addedTextTagIds, parseTextTags, tagMarkdown } from '../markdown'
import { canStartTag, findTagTrigger, isTagQuery } from '../trigger'
import { normalizeTagName } from '../names'
import { isTagColor, nextTagColor, TAG_COLORS } from '../palette'
import { TAGGABLE, isTagKind } from '../kinds'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('tag markdown', () => {
  it('round-trips a tag link', () => {
    const md = tagMarkdown({ id: A.toUpperCase(), name: 'Q4 [launch]' })
    expect(md).toBe(`[#Q4 launch](tag://${A})`)
    expect(parseTextTags(`see ${md} today`)).toEqual([{ id: A, name: 'Q4 launch' }])
  })

  it('ignores tags inside code and repeats', () => {
    const md = `${tagMarkdown({ id: A, name: 'a' })} \`${tagMarkdown({ id: B, name: 'b' })}\` ${tagMarkdown({ id: A, name: 'a' })}`
    expect(parseTextTags(md).map((t) => t.id)).toEqual([A])
  })

  it('reports only tags new to the text', () => {
    const before = tagMarkdown({ id: A, name: 'a' })
    const after = `${before} ${tagMarkdown({ id: B, name: 'b' })}`
    expect(addedTextTagIds(before, after)).toEqual([B])
    expect(addedTextTagIds(after, before)).toEqual([])
    expect(addedTextTagIds(null, before)).toEqual([A])
  })
})

describe('the # trigger', () => {
  const at = (v: string) => findTagTrigger(v, v.length)

  it('opens at a word start', () => {
    expect(at('#')).toEqual({ start: 0, query: '' })
    expect(at('hello #ren')).toEqual({ start: 6, query: 'ren' })
    expect(at('line\n#q4')).toEqual({ start: 5, query: 'q4' })
    expect(at('(#x')).toEqual({ start: 1, query: 'x' })
  })

  it('never opens mid-word, in a URL, in code or for a heading', () => {
    expect(at('C#')).toBeNull()
    expect(at('issue#4')).toBeNull()
    expect(at('https://example.com/#top')).toBeNull()
    expect(at('# ')).toBeNull()
    expect(at('## h')).toBeNull()
    expect(at('`code #x')).toBeNull()
    expect(at('#two words')).toBeNull()
  })

  it('limits the query', () => {
    expect(isTagQuery('a'.repeat(64))).toBe(true)
    expect(isTagQuery('a'.repeat(65))).toBe(false)
    expect(isTagQuery('team/ops')).toBe(true)
    expect(canStartTag('x')).toBe(false)
    expect(canStartTag(undefined)).toBe(true)
  })
})

describe('tag names and colors', () => {
  it('normalizes names', () => {
    expect(normalizeTagName('  #Renewal  ')).toBe('Renewal')
    expect(normalizeTagName('a,b')).toBeNull()
    expect(normalizeTagName('   ')).toBeNull()
    expect(normalizeTagName('x'.repeat(65))).toBeNull()
  })

  it('picks a free color, never grey first', () => {
    expect(isTagColor(nextTagColor('a', []))).toBe(true)
    expect(nextTagColor('a', [])).not.toBe('#6b7280')
    expect(nextTagColor('a', [TAG_COLORS[0]])).toBe(TAG_COLORS[1])
    expect(TAG_COLORS).toContain(nextTagColor('zzz', [...TAG_COLORS]))
  })
})

describe('taggable kinds', () => {
  it('names a join table per kind', () => {
    expect(isTagKind('document')).toBe(true)
    expect(isTagKind('toString')).toBe(false)
    expect(TAGGABLE.email_thread.column).toBe('thread_id')
    expect(new Set(Object.values(TAGGABLE).map((d) => d.join)).size).toBe(Object.keys(TAGGABLE).length)
  })
})

import { tagColorStore } from '../color-store'

describe('tag color store', () => {
  it('notifies only on change', () => {
    tagColorStore.reset()
    let n = 0
    const off = tagColorStore.subscribe(() => n++)
    tagColorStore.put([{ id: A.toUpperCase(), color: '#ef4444' }])
    tagColorStore.put([{ id: A, color: '#ef4444' }, { id: B, color: null }])
    expect(n).toBe(1)
    expect(tagColorStore.get(A)).toBe('#ef4444')
    off()
  })
})
