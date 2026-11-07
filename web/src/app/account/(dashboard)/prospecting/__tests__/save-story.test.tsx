// @vitest-environment jsdom
/**
 * THE SAVE/SEQUENCE STORY BANNER (C5).
 *
 * What this suite is actually defending: a sentence that is TRUE about a save,
 * and reachable afterwards.
 *
 * The banner exists because the old outcome was `toast.success(...)` — four
 * seconds, in a corner, unreachable. That was survivable while Save was a
 * button the user had just pressed. It stopped being survivable when Scout
 * could save fourteen rows from the chat strip beside the list: the counts
 * move, the user pressed nothing, and there is no gesture for a toast to hang
 * off. So the outcome became something that stays on screen and can be clicked.
 *
 * The three failure modes this pins, in the order they would bite:
 *
 *  1. ZERO CLAUSES RENDERED. "0 companies and 2 people added to your CRM" is
 *     the tempting shape because it is one template with no branches. It also
 *     invites the reader to wonder which company failed, when in fact none was
 *     ever selected. Zero clauses DROP; the sentence shrinks to the true one.
 *  2. NOUNS THAT DISAGREE WITH THEIR COUNTS. "1 companies", "1 people". The
 *     banner is the one place the outcome is stated in words, and words that
 *     do not agree read as a placeholder someone forgot to finish.
 *  3. COUNTS WITH NOWHERE TO GO. "2 need review" is the clause that matters
 *     most — those are people the save route REFUSED, and the only way to act
 *     on them is to look at them. A count with no doorway is a receipt.
 *
 * And one thing that is deliberately NOT a link: "N skipped" collects
 * unrelated refusals (no domain, already dismissed, a write that failed) with
 * no single destination that would hold them all. Inventing a doorway to a set
 * that does not exist would be worse than the plain number.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { SaveStoryBanner, savedClause, type SaveStory } from '../save-story'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function story(overrides: Partial<SaveStory> = {}): SaveStory {
  return {
    kind: 'published',
    companies: 6,
    people: 8,
    needsReview: 0,
    skippedOther: 0,
    enrolled: null,
    source: 'page',
    at: 1_700_000_000_000,
    ...overrides,
  }
}

const onOpenSaved = vi.fn()
const onOpenNeedsReview = vi.fn()
const onOpenSequence = vi.fn()
const onDismiss = vi.fn()

async function render(s: SaveStory) {
  onOpenSaved.mockReset()
  onOpenNeedsReview.mockReset()
  onOpenSequence.mockReset()
  onDismiss.mockReset()
  await act(async () => {
    root.render(
      <SaveStoryBanner
        story={s}
        onOpenSaved={onOpenSaved}
        onOpenNeedsReview={onOpenNeedsReview}
        onOpenSequence={onOpenSequence}
        onDismiss={onDismiss}
      />,
    )
  })
}

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  )
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// ---------------------------------------------------------------------------

describe('savedClause — the sentence, before any markup', () => {
  it('names both kinds when both were saved', () => {
    expect(savedClause(story({ companies: 6, people: 8 }))).toBe(
      '6 companies and 8 people added to your CRM',
    )
  })

  it('drops the zero half rather than rendering "0 companies and …"', () => {
    expect(savedClause(story({ companies: 0, people: 2 }))).toBe(
      '2 people added to your CRM',
    )
    expect(savedClause(story({ companies: 3, people: 0 }))).toBe(
      '3 companies added to your CRM',
    )
  })

  it('agrees with its own nouns at one of each', () => {
    expect(savedClause(story({ companies: 1, people: 1 }))).toBe(
      '1 company and 1 person added to your CRM',
    )
    expect(savedClause(story({ companies: 1, people: 0 }))).toBe(
      '1 company added to your CRM',
    )
    expect(savedClause(story({ companies: 0, people: 1 }))).toBe(
      '1 person added to your CRM',
    )
  })

  it('has nothing to say when nothing was saved', () => {
    expect(savedClause(story({ companies: 0, people: 0 }))).toBeNull()
  })
})

describe('SaveStoryBanner — the clauses', () => {
  it('joins what happened into one sentence', async () => {
    await render(
      story({
        companies: 6,
        people: 8,
        needsReview: 2,
        skippedOther: 1,
        enrolled: { count: 8, sequenceId: 'seq-1', sequenceName: 'Q4 Outbound' },
      }),
    )
    const said = text()
    expect(said).toContain('6 companies and 8 people added to your CRM')
    expect(said).toContain('8 enrolled in Q4 Outbound')
    expect(said).toContain('2 need review')
    expect(said).toContain('1 skipped')
  })

  it('drops every zero clause', async () => {
    await render(story({ companies: 0, people: 2, needsReview: 0, skippedOther: 0 }))
    const said = text()
    expect(said).toContain('2 people added to your CRM')
    expect(said).not.toContain('companies')
    expect(said).not.toContain('need review')
    expect(said).not.toContain('skipped')
    expect(said).not.toContain('enrolled')
  })

  /**
   * An enrollment with no save is a real case: Scout enrolls contacts that were
   * already in the CRM, so there is nothing to promote. The banner must then be
   * the enrollment alone rather than "0 added to your CRM · 8 enrolled".
   */
  it('stands on the enrollment alone when nothing was saved', async () => {
    await render(
      story({
        companies: 0,
        people: 0,
        enrolled: { count: 8, sequenceId: 'seq-1', sequenceName: 'Q4 Outbound' },
      }),
    )
    expect(text()).toBe('8 enrolled in Q4 Outbound')
  })

  it('still links a sequence whose name did not come back', async () => {
    // The id is what the link needs; the name is what the sentence wants. A
    // missing name is a worse sentence, not a broken destination.
    await render(
      story({ enrolled: { count: 3, sequenceId: 'seq-9', sequenceName: null } }),
    )
    expect(text()).toContain('3 enrolled in a sequence')
    await click(button('3 enrolled')!)
    expect(onOpenSequence).toHaveBeenCalledWith('seq-9', null)
  })

  it('reports an enrollment with no sequence id as text, not a link to nowhere', async () => {
    // Scout's extractor falls back to '' when an enroll output carries no
    // sequence_id. The enrollment still happened, so the count is still told —
    // but a button routing on '' lands the user on a blank sequence page, and a
    // doorway that opens onto nothing is worse than a plain sentence.
    await render(story({ enrolled: { count: 4, sequenceId: '', sequenceName: 'Q4 Outbound' } }))
    expect(text()).toContain('4 enrolled in Q4 Outbound')
    expect(button('4 enrolled in Q4 Outbound')).toBeUndefined()
  })

  it('renders nothing at all for an empty story', async () => {
    await render(story({ companies: 0, people: 0, needsReview: 0, skippedOther: 0 }))
    expect(container.textContent?.trim()).toBe('')
  })
})

describe('SaveStoryBanner — every count is a doorway', () => {
  it('opens the saved rows', async () => {
    await render(story())
    await click(button('6 companies and 8 people')!)
    expect(onOpenSaved).toHaveBeenCalledTimes(1)
  })

  it('opens the needs-review rows — the clause the user can actually act on', async () => {
    await render(story({ needsReview: 2 }))
    await click(button('2 need review')!)
    expect(onOpenNeedsReview).toHaveBeenCalledTimes(1)
  })

  it('opens the sequence its people landed in', async () => {
    await render(
      story({ enrolled: { count: 8, sequenceId: 'seq-1', sequenceName: 'Q4 Outbound' } }),
    )
    await click(button('8 enrolled in Q4 Outbound')!)
    expect(onOpenSequence).toHaveBeenCalledWith('seq-1', 'Q4 Outbound')
  })

  it('leaves "N skipped" as plain text — there is no one place those rows live', async () => {
    await render(story({ companies: 0, people: 1, skippedOther: 3 }))
    expect(text()).toContain('3 skipped')
    expect(button('3 skipped')).toBeUndefined()
  })

  it('is dismissible', async () => {
    await render(story())
    await click(container.querySelector('[aria-label="Dismiss"]')!)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('SaveStoryBanner — the origin', () => {
  /**
   * The page and Scout tell the SAME sentence: a user who asked Scout to save
   * the A-tier ones should not have to learn a second vocabulary for the
   * outcome. `source` rides on the element so a test (and a future debugger)
   * can tell which path produced the banner, and is deliberately absent from
   * the copy.
   */
  it('marks which path produced it without saying so in the copy', async () => {
    await render(story({ source: 'scout' }))
    expect(container.querySelector('[data-save-story="scout"]')).toBeTruthy()
    expect(text().toLowerCase()).not.toContain('scout')

    await render(story({ source: 'page' }))
    expect(container.querySelector('[data-save-story="page"]')).toBeTruthy()
  })

  it('is announced, so a save the user did not press is not silent', async () => {
    await render(story({ source: 'scout' }))
    expect(container.querySelector('[role="status"]')).toBeTruthy()
  })
})

/**
 * SAVE vs PUBLISH (migration 259): the same banner tells both, and the head
 * clause is what says which. A save story opens onto the publish, so the user
 * is never left wondering what to press next; a published story never does.
 */
describe('savedClause — save vs publish', () => {
  it('says "saved to the list" for a save, and names the list for a publish', () => {
    expect(savedClause(story({ kind: 'saved' }))).toBe('6 companies and 8 people saved to the list')
    expect(savedClause(story({ kind: 'published', listName: 'Q4 outbound' }))).toBe(
      '6 companies and 8 people added to your CRM under “Q4 outbound”',
    )
    expect(savedClause(story({ kind: 'published' }))).toBe('6 companies and 8 people added to your CRM')
  })
})

describe('SaveStoryBanner — the Publish doorway', () => {
  it('a SAVE story offers Publish to CRM when the page can publish, a PUBLISHED one never does', async () => {
    const onPublish = vi.fn()
    await act(async () => {
      root.render(
        <SaveStoryBanner
          story={story({ kind: 'saved' })}
          onOpenSaved={onOpenSaved}
          onOpenNeedsReview={onOpenNeedsReview}
          onOpenSequence={onOpenSequence}
          onPublish={onPublish}
          onDismiss={onDismiss}
        />,
      )
    })
    expect(text()).toContain('6 companies and 8 people saved to the list')
    await act(async () => {
      button('Publish to CRM')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onPublish).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(
        <SaveStoryBanner
          story={story({ kind: 'published' })}
          onOpenSaved={onOpenSaved}
          onOpenNeedsReview={onOpenNeedsReview}
          onOpenSequence={onOpenSequence}
          onPublish={onPublish}
          onDismiss={onDismiss}
        />,
      )
    })
    expect(button('Publish to CRM')).toBeUndefined()
  })
})
