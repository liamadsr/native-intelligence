import { describe, expect, it } from 'vitest'
import { autoCheck, cleanItemText, covers, EMPTY_CHECKS, itemsFromText, itemStems, nextItem, toggle, type ChecklistItem } from '../checklist'
import { tokenize } from '../normalize'

const contentStems = itemStems

const ITEMS: ChecklistItem[] = [
  { id: 'a', text: 'Show the pipeline board' },
  { id: 'b', text: 'Drag a deal to Won' },
  { id: 'c', text: 'Explain how the forecast updates' },
  { id: 'd', text: 'Filters by owner and close date' },
  { id: 'e', text: 'Pricing' },
]
const heard = (text: string) => tokenize(text)

describe('covers', () => {
  it('checks when most of the item is said close together', () => {
    expect(covers(contentStems('Show the pipeline board'), heard('so let me show you the pipeline board real quick'))).toBe(true)
    expect(covers(contentStems('Explain how the forecast updates'), heard('and you see the forecast just updated on its own'))).toBe(true)
  })

  it('takes a paraphrase that keeps the item’s words in another order', () => {
    expect(covers(contentStems('Filters by owner and close date'), heard('you can narrow it by close date or by owner with the filters'))).toBe(true)
  })

  it('misses when too few of the words are said', () => {
    expect(covers(contentStems('Filters by owner and close date'), heard('here are the filters'))).toBe(false)
    expect(covers(contentStems('Explain how the forecast updates'), heard('the forecast'))).toBe(false)
  })

  it('misses when the words are far apart (said by chance, not as the point)', () => {
    const words = 'I wanted to show you something today and it is a long story about the team and the market and how we got here and why the pipeline matters to everyone on the sales team today and much later on we will get to the board'
    expect(covers(contentStems('Show the pipeline board'), heard(words))).toBe(false)
  })

  it('never checks an item of one content word', () => {
    expect(covers(contentStems('Pricing'), heard('now pricing pricing pricing'))).toBe(false)
  })

  it('needs at least two words even for a two-word item', () => {
    expect(covers(contentStems('Drag deal'), heard('drag it'))).toBe(false)
    expect(covers(contentStems('Drag deal'), heard('drag the deal over'))).toBe(true)
  })
})

describe('autoCheck', () => {
  it('checks what was covered and marks it as checked by itself', () => {
    const state = autoCheck(ITEMS, EMPTY_CHECKS, heard('first let me show you the pipeline board'))
    expect([...state.checked]).toEqual(['a'])
    expect(state.auto.has('a')).toBe(true)
  })

  it('looks only at the latest words', () => {
    const old = heard('drag a deal to won')
    const filler = heard(Array.from({ length: 40 }, () => 'and').join(' '))
    expect(autoCheck(ITEMS, EMPTY_CHECKS, [...old, ...filler]).checked.size).toBe(0)
  })

  it('never checks an item the person unchecked by hand', () => {
    let state = autoCheck(ITEMS, EMPTY_CHECKS, heard('drag a deal over to won'))
    expect(state.checked.has('b')).toBe(true)
    state = toggle(state, 'b')
    expect(state.checked.has('b')).toBe(false)
    state = autoCheck(ITEMS, state, heard('again drag the deal to won'))
    expect(state.checked.has('b')).toBe(false)
  })

  it('returns the same state when nothing changes', () => {
    expect(autoCheck(ITEMS, EMPTY_CHECKS, heard('hello everyone'))).toBe(EMPTY_CHECKS)
  })
})

describe('toggle and nextItem', () => {
  it('checks and unchecks by hand, and a check by hand clears the hold', () => {
    let state = toggle(EMPTY_CHECKS, 'c')
    expect(state.checked.has('c')).toBe(true)
    expect(state.auto.has('c')).toBe(false)
    state = toggle(state, 'c')
    expect(state.heldOpen.has('c')).toBe(true)
    state = toggle(state, 'c')
    expect(state.heldOpen.has('c')).toBe(false)
    expect(state.checked.has('c')).toBe(true)
  })

  it('points at the first item not done', () => {
    expect(nextItem(ITEMS, EMPTY_CHECKS)).toBe('a')
    expect(nextItem(ITEMS, toggle(EMPTY_CHECKS, 'a'))).toBe('b')
    const all = ITEMS.reduce((s, i) => toggle(s, i.id), EMPTY_CHECKS)
    expect(nextItem(ITEMS, all)).toBeNull()
  })
})

describe('itemStems', () => {
  it('leaves out the words that say what to do with the point', () => {
    expect(itemStems('Explain how the forecast updates')).toEqual(['forecast', 'updat'])
    expect(itemStems('Quickly show the pipeline board')).toEqual(['pipelin', 'board'])
  })
})

describe('item text', () => {
  it('drops a list marker typed or pasted with the item', () => {
    expect(cleanItemText('1. Show the board')).toBe('Show the board')
    expect(cleanItemText('- Show the board')).toBe('Show the board')
    expect(cleanItemText('• Show the board')).toBe('Show the board')
    expect(cleanItemText('[ ] Show the board')).toBe('Show the board')
    expect(cleanItemText('2) Show')).toBe('Show')
  })

  it('makes one item per pasted line, blank lines out', () => {
    expect(itemsFromText('1. One\n\n2. Two\n  \n- Three', (i) => `i${i}`)).toEqual([{ id: 'i0', text: 'One' }, { id: 'i1', text: 'Two' }, { id: 'i2', text: 'Three' }])
  })
})
