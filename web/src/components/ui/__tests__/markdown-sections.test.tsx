// @vitest-environment jsdom
/**
 * The hover "play this section" button in rendered markdown (../markdown.tsx,
 * ../markdown-sections.tsx), driven through the real Markdown and the real
 * section player, with the desktop bridge mocked:
 *  - unsupported: no button, and hovering does no work at all;
 *  - hovering an eligible heading shows ONE button, after its text, until the
 *    pointer leaves; a short section, a nested heading, a streaming text and
 *    (with skipWhole) a section that is the whole text get none;
 *  - a bold lead-in paragraph is an anchor; every other paragraph is a plain <p>;
 *  - click → the section's sentences; while playing the button stays, as
 *    Pause, without hover, and the section's blocks carry
 *    data-read-aloud-reading;
 *  - Pause keeps the place: the button stays, as Resume, with a dimmer bar
 *    (data-read-aloud-reading="paused"), and Resume picks up at the sentence
 *    it stopped in; only the most recent pause keeps them, an older paused
 *    section says Resume on hover; the heading going away pauses its section.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ComponentProps } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown?]>,
  listeners: new Set<(p: TtsStatePayload) => void>(),
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async (args: unknown) => {
      bridge.calls.push(['speak', args])
    },
    ttsCancel: async () => {
      bridge.calls.push(['cancel'])
    },
    ttsPrepare: async () => {
      bridge.calls.push(['prepare'])
    },
    onTtsState: (cb: (p: TtsStatePayload) => void) => {
      bridge.listeners.add(cb)
      return () => bridge.listeners.delete(cb)
    },
  },
}))
vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }))
// The real rules, watched: hovering must do no work where read-aloud is unsupported.
vi.mock('@/lib/read-aloud/sections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/read-aloud/sections')>()
  return { ...actual, collectDomSection: vi.fn(actual.collectDomSection) }
})

import { Markdown } from '../markdown'
import { collectDomSection } from '@/lib/read-aloud/sections'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getLastPausedKey, getResumePoint } from '@/lib/read-aloud/resume-points'

const LONG = 'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.'

const MD = [
  'Intro line before the plan.',
  '## Plan',
  LONG,
  '- Book the room',
  '- Send the deck',
  '```js\nnpm install\n```',
  '## Tiny',
  'Too short to play.',
  '## Wrap-up',
  '**Next steps**',
  `${LONG} Then we regroup.`,
  '> ## Quoted heading',
  `> ${LONG}`,
].join('\n\n')

let container: HTMLDivElement
let root: Root

async function mount(props: Partial<ComponentProps<typeof Markdown>> & { children?: string } = {}) {
  await act(async () => root.render(h(Markdown, { children: MD, ...props })))
}

const heading = (text: string) =>
  [...container.querySelectorAll('h1, h2, h3, h4, p')].find((el) => el.textContent === text) as HTMLElement

function hover(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
  })
}

function unhover(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  })
}

const buttons = () => [...container.querySelectorAll('[data-read-aloud-section]')] as HTMLButtonElement[]
const spoken = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { text: string }).text)
const spokenIds = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { id: string }).id)
const readingValues = () =>
  [...container.querySelectorAll('[data-read-aloud-reading]')].map((el) => [el.tagName, el.getAttribute('data-read-aloud-reading')])

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function emit(p: TtsStatePayload) {
  await act(async () => {
    for (const cb of [...bridge.listeners]) cb(p)
  })
}

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  setSectionPlayerSupported(true)
  bridge.calls = []
  bridge.listeners.clear()
  vi.mocked(collectDomSection).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
})

describe('Markdown sections — when a button shows', () => {
  it('unsupported: no button, and hovering does no work', async () => {
    setSectionPlayerSupported(false)
    await mount()
    hover(heading('Plan'))
    expect(buttons()).toEqual([])
    expect(collectDomSection).not.toHaveBeenCalled()
    expect(bridge.calls).toEqual([])
  })

  it('hovering an eligible heading shows one Play button after its text, gone when the pointer leaves', async () => {
    await mount()
    const plan = heading('Plan')
    hover(plan)
    expect(buttons()).toHaveLength(1)
    const [button] = buttons()
    expect(button.parentElement).toBe(plan)
    expect(plan.lastElementChild).toBe(button)
    expect(button.getAttribute('aria-label')).toBe('Play this section')
    expect(button.title).toBe('Play this section')
    expect(button.dataset.readAloudSection).toBe('play')
    // Hovering warms the engine.
    expect(bridge.calls).toEqual([['prepare']])

    unhover(plan)
    expect(buttons()).toEqual([])
  })

  it('a short section gets none', async () => {
    await mount()
    hover(heading('Tiny'))
    expect(buttons()).toEqual([])
  })

  it('a heading nested in a quote is no anchor', async () => {
    await mount()
    hover(heading('Quoted heading'))
    expect(buttons()).toEqual([])
  })

  it('a bold lead-in paragraph is an anchor; a normal paragraph is a plain <p>', async () => {
    await mount()
    const lead = heading('Next steps')
    expect(lead.tagName).toBe('P')
    hover(lead)
    expect(buttons()).toHaveLength(1)
    expect(buttons()[0].parentElement).toBe(lead)

    unhover(lead)
    const plain = [...container.querySelectorAll('p')].find((p) => p.textContent === 'Too short to play.')!
    expect(plain.outerHTML).toBe('<p>Too short to play.</p>')
    hover(plain)
    expect(buttons()).toEqual([])
  })

  it('none while the text streams; the same blocks get it once the stream is done', async () => {
    await mount({ readAloudSections: false })
    hover(heading('Plan'))
    expect(buttons()).toEqual([])
    unhover(heading('Plan'))

    await mount({ readAloudSections: true })
    hover(heading('Plan'))
    expect(buttons()).toHaveLength(1)
  })

  it('skipWhole: none for a section that is the whole text, but one for a part of it', async () => {
    await mount({ children: `## Only\n\n${LONG}`, readAloudSkipWhole: true })
    hover(heading('Only'))
    expect(buttons()).toEqual([])
    unhover(heading('Only'))

    await mount({ children: `## Only\n\n${LONG}`, readAloudSkipWhole: false })
    hover(heading('Only'))
    expect(buttons()).toHaveLength(1)
    unhover(heading('Only'))

    await mount({ readAloudSkipWhole: true })
    hover(heading('Plan'))
    expect(buttons()).toHaveLength(1)
  })

  it("a consumer's own component for a tag wins", async () => {
    await mount({ components: { h2: ({ children }) => h('h2', { className: 'custom' }, children) } })
    hover(heading('Plan'))
    expect(buttons()).toEqual([])
    expect(heading('Plan').className).toBe('custom')
  })
})

describe('Markdown sections — playing', () => {
  it('click reads the section: the heading, its prose and items, never the code', async () => {
    await mount()
    hover(heading('Plan'))
    await act(async () => buttons()[0].click())
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    expect(bridge.calls.find((c) => c[0] !== 'prepare')).toEqual(['cancel'])
    expect(spoken()).toEqual([
      'Plan.',
      'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.',
      'Book the room.',
      'Send the deck.',
    ])
    expect(getSectionPlayerSnapshot().playingKey).toMatch(/^md:/)
  })

  it('while playing: Pause without hover, the section highlighted; Pause cancels and leaves Resume with a dimmer bar', async () => {
    await mount()
    const plan = heading('Plan')
    hover(plan)
    await act(async () => buttons()[0].click())
    unhover(plan)

    expect(buttons()).toHaveLength(1)
    const pause = buttons()[0]
    expect(pause.getAttribute('aria-label')).toBe('Pause reading')
    expect(pause.dataset.readAloudSection).toBe('pause')
    expect(pause.querySelector('svg')?.classList.contains('lucide-pause')).toBe(true)

    const marked = [...container.querySelectorAll('[data-read-aloud-reading]')]
    expect(marked[0]).toBe(plan)
    expect(readingValues()).toEqual([['H2', ''], ['P', ''], ['UL', ''], ['DIV', '']])
    expect(heading('Tiny').hasAttribute('data-read-aloud-reading')).toBe(false)

    bridge.calls = []
    await act(async () => pause.click())
    expect(bridge.calls).toEqual([['cancel']])
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    const key = getLastPausedKey()!
    expect(key).toMatch(/^md:/)
    expect(getResumePoint(key)).toBe(0)

    // The most recent pause: Resume stays without a hover, the bar dims.
    expect(buttons()).toHaveLength(1)
    const resume = buttons()[0]
    expect(resume.parentElement).toBe(plan)
    expect(resume.getAttribute('aria-label')).toBe('Resume this section')
    expect(resume.dataset.readAloudSection).toBe('resume')
    expect(resume.querySelector('svg')?.classList.contains('lucide-play')).toBe(true)
    expect(readingValues()).toEqual([['H2', 'paused'], ['P', 'paused'], ['UL', 'paused'], ['DIV', 'paused']])
  })

  it('Resume picks up at the sentence it stopped in', async () => {
    await mount()
    hover(heading('Plan'))
    await act(async () => buttons()[0].click())
    await settle()
    await emit({ id: spokenIds()[2], state: 'speaking' }) // "Book the room."
    await act(async () => buttons()[0].click()) // Pause
    bridge.calls = []
    await act(async () => buttons()[0].click()) // Resume
    await settle()
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(spoken()).toEqual(['Book the room.', 'Send the deck.'])
    expect(buttons()[0].dataset.readAloudSection).toBe('pause')
    expect(readingValues().every(([, value]) => value === '')).toBe(true)
  })

  it('only the most recent pause keeps its button and bar; an older one says Resume on hover', async () => {
    await mount()
    const plan = heading('Plan')
    const wrapUp = heading('Wrap-up')
    hover(plan)
    await act(async () => buttons()[0].click()) // Play
    await act(async () => buttons()[0].click()) // Pause
    unhover(plan)
    hover(wrapUp)
    await act(async () => buttons().find((b) => b.parentElement === wrapUp)!.click()) // Play
    // Plan, paused before, still shows while Wrap-up plays.
    expect(buttons().map((b) => [b.parentElement!.textContent, b.dataset.readAloudSection])).toEqual([
      ['Plan', 'resume'],
      ['Wrap-up', 'pause'],
    ])
    await act(async () => buttons().find((b) => b.parentElement === wrapUp)!.click()) // Pause
    unhover(wrapUp)

    expect(buttons().map((b) => b.parentElement)).toEqual([wrapUp])
    expect(plan.hasAttribute('data-read-aloud-reading')).toBe(false)
    expect(wrapUp.getAttribute('data-read-aloud-reading')).toBe('paused')

    hover(plan)
    const planButton = buttons().find((b) => b.parentElement === plan)!
    expect(planButton.dataset.readAloudSection).toBe('resume')
    expect(planButton.getAttribute('aria-label')).toBe('Resume this section')
  })

  it('goes back to idle when the last sentence is done', async () => {
    await mount()
    hover(heading('Next steps'))
    await act(async () => buttons()[0].click())
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    const ids = bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { id: string }).id)
    await act(async () => {
      for (const id of ids) for (const cb of [...bridge.listeners]) cb({ id, state: 'done' })
    })
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(container.querySelectorAll('[data-read-aloud-reading]')).toHaveLength(0)
  })

  it('the playing heading going away pauses its section', async () => {
    await mount()
    hover(heading('Plan'))
    await act(async () => buttons()[0].click())
    bridge.calls = []
    await mount({ children: 'Something else entirely.' })
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(bridge.calls).toEqual([['cancel']])
    expect(getResumePoint(getLastPausedKey()!)).toBe(0)
  })
})
