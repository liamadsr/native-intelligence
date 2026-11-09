// @vitest-environment jsdom
/**
 * ActionPlatformIcon — the far-left mark that answers "whose item is this?".
 *
 * Three claims, and every one of them is a claim about TRUTH rather than about
 * looks:
 *
 *  - No links is not an empty state. It is the Native Intelligence mark, because a Native Intelligence
 *    action with no links IS a Native Intelligence action, and drawing nothing there would
 *    make the column appear and disappear as things get pushed.
 *  - One link shows that provider. Two or more show ALL of them (up to three,
 *    then a count) — `action_external_task` is UNIQUE per action+PROVIDER, so
 *    an action legitimately lives in three trackers at once, and a mark that
 *    showed only the first would be quietly wrong about the other two.
 *  - As a BUTTON it stops both the click and the pointer-down, because both
 *    surfaces it mounts in have a gesture underneath: the list row opens the
 *    detail panel on click, the board card begins a drag on pointer-down. The
 *    second one is the one that is easy to forget and impossible to notice
 *    until a user tries to press the icon and drags the card instead.
 *
 * The provider marks are asserted through `data-platform-icon` rather than by
 * hunting SVG paths: the brand icons are third-party components whose internals
 * are not this component's contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ActionPlatformIcon, platformIconLabel } from '../action-platform-icon'

let container: HTMLDivElement
let root: Root

async function render(props: Parameters<typeof ActionPlatformIcon>[0] = {}) {
  await act(async () => {
    root.render(h(ActionPlatformIcon, props))
  })
}

/**
 * The icon inside a stand-in for the surfaces it really mounts in: an outer
 * element carrying the row's own gesture handlers, so propagation is tested
 * through React's synthetic system exactly as it happens in a real row.
 */
async function renderInRow(
  props: Parameters<typeof ActionPlatformIcon>[0],
  rowHandlers: { onClick?: () => void; onPointerDown?: () => void },
) {
  await act(async () => {
    root.render(
      h(
        'div',
        rowHandlers,
        h(ActionPlatformIcon, props),
        h('span', { 'data-row-body': '' }, 'the rest of the row'),
      ),
    )
  })
}

/** The rendered mark, whichever element it is (button when interactive). */
function mark(): HTMLElement {
  return container.querySelector('[data-platform-icon]') as HTMLElement
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ActionPlatformIcon — what it claims', () => {
  it('an NI-only action shows the Native Intelligence mark, not an empty slot', async () => {
    await render({ links: [] })
    expect(mark()).toBeTruthy()
    expect(mark().getAttribute('data-platform-icon')).toBe('dial8')
    expect(mark().getAttribute('aria-label')).toBe('Native Intelligence action — send it to a task app')
  })

  /**
   * NEW (the icon rework). Liam: "You're not using the correct dilate icon."
   *
   * The component drew `Mark` from `@/components/logo` — the marketing
   * constellation-of-dots. The mark that means "this is a Native Intelligence item" is the one
   * the PRODUCT wears: `public/icon.png`, the NI mark that layout.tsx serves
   * as the favicon. Sitting in a row beside the Jira, Asana and Linear brand
   * marks, anything else reads as a fourth vendor.
   *
   * Asserted through `data-dial8-mark` rather than by hunting the svg paths the
   * old glyph had: the point is WHICH artwork, and the artwork is now a raster.
   */
  it('draws the APP icon, not the marketing glyph', async () => {
    await render({ links: [] })
    const glyph = container.querySelector('[data-dial8-mark]') as HTMLElement
    expect(glyph).toBeTruthy()
    // The marketing Mark is an <svg> of ~20 circles; the app mark is not.
    expect(container.querySelector('svg')).toBeNull()
  })

  /**
   * NEW (the icon rework). The PNG is solid black on transparent and there is no
   * SVG source of it in the repo, so it is painted as a MASK: `currentColor`
   * through the alpha channel. A raw <img> would be invisible on a dark sidebar
   * and unable to dim with a disabled row; the mask inherits `text-*` like every
   * sibling glyph, which is one rule covering light, dark and disabled at once.
   */
  it('tints itself with currentColor rather than baking in black', async () => {
    await render({ links: [] })
    const glyph = container.querySelector('[data-dial8-mark]') as HTMLElement
    expect(glyph.style.backgroundColor).toBe('currentcolor')
    expect(glyph.style.maskImage).toContain('/icon.png')
    expect(glyph.style.maskSize).toBe('contain')
    // Never an <img>: that is the version that disappears in dark mode.
    expect(container.querySelector('img')).toBeNull()
    // And it takes the row's text colour, so one class covers every state.
    expect(glyph.className).toContain('text-muted-foreground')
  })

  it('SWAPS the Native Intelligence mark out entirely once the action lives somewhere', async () => {
    // The mark answers "whose item is this?" — an action in Jira is not a Native Intelligence
    // item any more, so the glyph is replaced rather than accompanied.
    await render({ links: [{ provider: 'jira' }] })
    expect(container.querySelector('[data-dial8-mark]')).toBeNull()
  })

  it('treats absent links exactly like empty links', async () => {
    await render({})
    expect(mark().getAttribute('data-platform-icon')).toBe('dial8')
  })

  it('one link shows that provider', async () => {
    await render({ links: [{ provider: 'jira' }] })
    expect(mark().getAttribute('data-platform-icon')).toBe('jira')
    expect(mark().getAttribute('aria-label')).toBe('In Jira')
  })

  it('TWO links show BOTH, not just the first', async () => {
    await render({ links: [{ provider: 'jira' }, { provider: 'linear' }] })
    expect(mark().getAttribute('data-platform-icon')).toBe('jira,linear')
    expect(mark().getAttribute('aria-label')).toBe('In Jira and Linear')
  })

  it('three links show all three', async () => {
    await render({
      links: [{ provider: 'asana' }, { provider: 'jira' }, { provider: 'linear' }],
    })
    expect(mark().getAttribute('data-platform-icon')).toBe('asana,jira,linear')
    expect(mark().getAttribute('aria-label')).toBe('In Asana, Jira and Linear')
  })

  /**
   * REGRESSION (review finding: "Multi-provider icon stack order is
   * nondeterministic across surfaces and refreshes").
   *
   * The three sources of a link list disagree on order: the row payload's
   * embedded join has no ORDER BY (heap order, not stable across refreshes), the
   * menu's loadLinks flattens in LINK_PROVIDERS order, and a push PREPENDS the
   * new link while the bus republish appends. Nothing normalised, so the same
   * action's mark visibly reshuffled between the list row and the board card,
   * and re-ordered in place the moment a menu first read the real rows — reading
   * as a state change when nothing had changed. Sorting HERE, at the one
   * component that draws the stack, collapses all three sources at once.
   */
  it('draws the stack in canonical order regardless of input order', async () => {
    await render({ links: [{ provider: 'linear' }, { provider: 'jira' }] })
    expect(mark().getAttribute('data-platform-icon')).toBe('jira,linear')
  })

  it('canonical order holds for all three, whatever order they arrive in', async () => {
    await render({
      links: [{ provider: 'linear' }, { provider: 'asana' }, { provider: 'jira' }],
    })
    expect(mark().getAttribute('data-platform-icon')).toBe('asana,jira,linear')
  })

  /**
   * REGRESSION (review finding: "Applied proposal rows show a definitive
   * NI-only mark for unknown link state").
   *
   * Zero providers means "this action is in no tracker" — an affirmative claim,
   * with the tooltip to match. It is the WRONG answer to "nobody has asked yet",
   * which is the state every applied capture row is in after a page reload: the
   * compact menu defers its link fetch to first open (deliberately — eager
   * loading would fan out three GETs per row on a capture with dozens). The
   * menu's own default trigger already hedges with MoreHorizontal for exactly
   * this; the icon had no such state, so `linksKnown ? links : []` was a visual
   * no-op and every reloaded capture asserted NI-only for already-pushed
   * actions.
   */
  it('renders an explicit UNKNOWN state rather than claiming NI-only', async () => {
    await render({ links: [], known: false })
    expect(mark().getAttribute('data-platform-icon')).toBe('unknown')
    expect(mark().getAttribute('aria-label')).toBe('Task app options')
  })

  it('treats link state as known by default', async () => {
    // Every existing caller passes no `known` and means "this is the truth".
    await render({ links: [] })
    expect(mark().getAttribute('data-platform-icon')).toBe('dial8')
  })

  it('draws the real providers once they are known', async () => {
    await render({ links: [{ provider: 'jira' }], known: true })
    expect(mark().getAttribute('data-platform-icon')).toBe('jira')
  })

  it('a FOURTH link becomes a count rather than a fourth mark', async () => {
    await render({
      links: [
        { provider: 'asana' },
        { provider: 'jira' },
        { provider: 'linear' },
        { provider: 'notion' },
      ],
    })
    // Every provider is still NAMED — the overflow is a rendering budget, not a
    // decision to stop telling the truth.
    expect(mark().getAttribute('aria-label')).toBe('In Asana, Jira, Linear and notion')
    expect(mark().textContent).toContain('+1')
  })

  it('de-duplicates by provider so a doubled patch never draws two Jiras', async () => {
    await render({ links: [{ provider: 'jira' }, { provider: 'jira' }] })
    expect(mark().getAttribute('data-platform-icon')).toBe('jira')
  })

  it('ignores a link with no provider rather than drawing a hole', async () => {
    await render({ links: [{ provider: '' }, { provider: 'jira' }] })
    expect(mark().getAttribute('data-platform-icon')).toBe('jira')
  })
})

describe('ActionPlatformIcon — interactivity', () => {
  it('is INERT (not a button) with no onOpen', async () => {
    await render({ links: [] })
    expect(mark().tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBeNull()
  })

  it('is a button that calls onOpen when one is given', async () => {
    const onOpen = vi.fn()
    await render({ links: [], onOpen })
    expect(mark().tagName).toBe('BUTTON')
    await act(async () => {
      mark().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('STOPS THE CLICK from reaching the row underneath', async () => {
    // The list row's own onClick opens the detail panel. Pressing the icon must
    // not also navigate.
    //
    // The wrapper is a REACT element rather than a bare addEventListener on the
    // container: React 19 delegates to the root, so a native listener on the
    // root fires before any component handler and would "pass" no matter what
    // the icon does. A real surface's handler is a React one, so the test's is
    // too.
    const rowClick = vi.fn()
    await renderInRow({ links: [], onOpen: vi.fn() }, { onClick: rowClick })
    await act(async () => {
      mark().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('STOPS THE POINTER-DOWN from reaching the board card underneath', async () => {
    // The board card is the drag source and drag begins on pointer-down — the
    // half a click-only guard would miss.
    const cardPointerDown = vi.fn()
    await renderInRow({ links: [], onOpen: vi.fn() }, { onPointerDown: cardPointerDown })
    await act(async () => {
      mark().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(cardPointerDown).not.toHaveBeenCalled()
  })

  it('a row handler DOES fire for a click that misses the icon (the guard is scoped)', async () => {
    // The counterpart to the two above: an icon that stopped everything on the
    // row would pass them and break the row.
    const rowClick = vi.fn()
    await renderInRow({ links: [], onOpen: vi.fn() }, { onClick: rowClick })
    await act(async () => {
      container
        .querySelector('[data-row-body]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(rowClick).toHaveBeenCalledTimes(1)
  })

  /**
   * ADDED by the review's test-quality finding: the CLICK half of the chaining
   * contract was pinned below, the POINTER-DOWN half was not — and pointer-down
   * is the one Radix actually opens its dropdown on. A component that dropped
   * the injected pointer-down while still stopping propagation would pass every
   * other test in this file and be inert as a trigger on the board card.
   */
  it('still runs an INJECTED pointer-down handler while stopping propagation', async () => {
    const injectedPointerDown = vi.fn()
    const cardPointerDown = vi.fn()
    await renderInRow(
      { links: [], onOpen: vi.fn(), onPointerDown: injectedPointerDown },
      { onPointerDown: cardPointerDown },
    )
    await act(async () => {
      mark().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    // Radix's own handler ran…
    expect(injectedPointerDown).toHaveBeenCalledTimes(1)
    // …and the card underneath still never saw it.
    expect(cardPointerDown).not.toHaveBeenCalled()
  })

  /**
   * ADDED by the review's test-quality finding: the guard was only ever asserted
   * against a single synthetic event. A drag is a SEQUENCE, and the board card's
   * dnd-kit PointerSensor arms it on POINTER-DOWN and only then tracks movement
   * — so replaying the whole gesture is what proves the icon is not a drag
   * handle. (The card is dnd-kit driven, not HTML5 draggable, which is why
   * pointer-down rather than `dragstart` is the event that has to be stopped.)
   */
  it('a full pointer drag gesture on the mark never arms the card’s drag', async () => {
    const cardPointerDown = vi.fn()
    await renderInRow(
      { links: [{ provider: 'jira' }], onOpen: vi.fn() },
      { onPointerDown: cardPointerDown },
    )

    await act(async () => {
      const target = mark()
      target.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
      )
      target.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 60, clientY: 40 }),
      )
      target.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 60, clientY: 40 }),
      )
    })

    // The sensor never saw the gesture begin, so nothing downstream of it runs.
    expect(cardPointerDown).not.toHaveBeenCalled()
  })

  it('still runs an injected handler — it is usable AS a menu trigger', async () => {
    // Radix's `asChild` trigger passes its open handler down as onClick; a
    // component that replaced it instead of chaining would be inert as a
    // trigger while looking perfectly fine.
    const injected = vi.fn()
    const onOpen = vi.fn()
    await render({ links: [], onOpen, onClick: injected })
    await act(async () => {
      mark().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(injected).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('does not open while the row is busy', async () => {
    const onOpen = vi.fn()
    await render({ links: [], onOpen, disabled: true })
    expect((mark() as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      mark().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('platformIconLabel', () => {
  it('reads as a sentence at every arity', () => {
    expect(platformIconLabel([])).toBe('Native Intelligence action — send it to a task app')
    expect(platformIconLabel(['jira'])).toBe('In Jira')
    expect(platformIconLabel(['jira', 'asana'])).toBe('In Jira and Asana')
    expect(platformIconLabel(['jira', 'asana', 'linear'])).toBe('In Jira, Asana and Linear')
  })
})
