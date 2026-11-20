// @vitest-environment jsdom
/**
 * The row under a thread's subject: the automatic labels (marked as such), the
 * person's own tags with "+ Add tags", and the people on the thread. People
 * and addresses are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { automaticLabels, EmailThreadTags, PEOPLE_SHOWN, threadPeople } from '../email-thread-tags'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sam = { name: 'Sam Rivera', email: 'sam@example.com' }
const priya = { name: 'Priya Natarajan', email: 'priya@example.org' }
const dana = { name: null, email: 'Dana@Example.org' }
const own = new Set(['sam@example.com'])

describe('automaticLabels', () => {
  it('puts "To respond" first, then the category', () => {
    expect(automaticLabels({ needs_reply: true, auto_classified: 'important' }).map((l) => l.label)).toEqual(['To respond', 'Important'])
    expect(automaticLabels({ needs_reply: false, auto_classified: 'transactional' }).map((l) => l.label)).toEqual(['Receipt'])
  })

  it('names a category it has no word for after itself, and shows nothing for none', () => {
    expect(automaticLabels({ auto_classified: 'calendar_change' }).map((l) => l.label)).toEqual(['Calendar change'])
    expect(automaticLabels({ needs_reply: null, auto_classified: null })).toEqual([])
    expect(automaticLabels({ auto_classified: '' })).toEqual([])
  })
})

describe('threadPeople', () => {
  it('lists everyone once, senders first, the person as "Me"', () => {
    const people = threadPeople(
      [
        { from: priya, to: [sam], cc: [dana] },
        { from: sam, to: [priya], cc: [] },
        { from: { name: null, email: 'priya@example.org' }, to: [sam], cc: [{ name: 'Dana Whitfield', email: 'dana@example.org' }] },
      ],
      own,
    )
    expect(people.map((p) => [p.email, p.label, p.me])).toEqual([
      ['priya@example.org', 'Priya', false],
      ['sam@example.com', 'Me', true],
      // The name a later message carried replaces the bare address.
      ['dana@example.org', 'Dana', false],
    ])
  })

  it('falls back to the mailbox name for an address with no name', () => {
    expect(threadPeople([{ from: { name: null, email: 'ops@example.net' }, to: [], cc: [] }], own)[0].label).toBe('ops')
  })
})

describe('EmailThreadTags', () => {
  let container: HTMLDivElement
  let root: Root
  const onRemoveLabel = vi.fn()

  beforeEach(() => {
    onRemoveLabel.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const crowd = Array.from({ length: 8 }, (_, i) => ({ name: `Guest ${i + 1}`, email: `guest${i + 1}@example.org` }))
  const render = (labels: Array<{ id: string; name: string; color: string }>, to = [sam]) =>
    act(() =>
      root.render(
        h(EmailThreadTags, {
          metadata: { needs_reply: true, auto_classified: 'personal' },
          labels,
          onRemoveLabel,
          picker: h('div', { 'data-picker': '' }, 'picker'),
          messages: [{ from: priya, to, cc: [] }],
          ownAddresses: own,
        }),
      ),
    )

  it('shows the automatic labels, marked as automatic, and "Add tags" when the thread has none', () => {
    render([])
    const auto = [...container.querySelectorAll('[data-auto-label]')]
    expect(auto.map((el) => el.textContent)).toEqual(['To respond', 'Personal'])
    expect(auto.every((el) => el.getAttribute('title') === 'Added automatically')).toBe(true)
    // An automatic label has no remove button: triage owns it.
    expect(auto.some((el) => el.querySelector('button'))).toBe(false)
    expect(container.querySelector('[data-add-tags]')!.textContent).toBe('Add tags')
  })

  it('shows the person’s tags, removes one on its ×, and shrinks "Add tags" to a +', () => {
    render([{ id: 'l1', name: 'Lease', color: '#5c8aee' }])
    expect(container.querySelector('[data-thread-label="l1"]')!.textContent).toBe('Lease')
    expect(container.querySelector('[data-add-tags]')!.textContent).toBe('')
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove Lease"]')!.click())
    expect(onRemoveLabel).toHaveBeenCalledWith('l1')
  })

  it('opens the label picker from "Add tags"', () => {
    render([])
    expect(document.querySelector('[data-picker]')).toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('[data-add-tags]')!.click())
    expect(document.querySelector('[data-picker]')).not.toBeNull()
  })

  it('shows the first people as chips and the rest behind "+N more"', () => {
    render([], [sam, ...crowd])
    const chips = () => [...container.querySelectorAll('[data-thread-person]')].map((el) => el.textContent)
    expect(chips()).toEqual(['PPriya', 'MMe', 'GGuest', 'GGuest', 'GGuest'])
    expect(chips().length).toBe(PEOPLE_SHOWN)
    const more = container.querySelector<HTMLButtonElement>('[data-more-people]')!
    expect(more.textContent).toBe('+5 more')
    act(() => more.click())
    expect(chips().length).toBe(10)
    expect(more.textContent).toBe('Show fewer')
  })
})
