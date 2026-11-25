// @vitest-environment jsdom
/**
 * The prompter as the person sees it while recording: the script's current line follows simulated live words
 * (interim guesses, then finals), scrolling by hand pauses following until Resume, a click on a line starts there,
 * the checklist checks by hand and by itself (never an item the person unchecked), and the next item is marked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChecklistItem } from '@/lib/studio/prompter/checklist'
import type { Following } from '@/lib/studio/prompter/channel'
import { linesOf } from '@/lib/studio/prompter/follow'
import { hear, NOTHING_HEARD, type Heard } from '@/lib/studio/prompter/live-words'
import { followingNote, PrompterPanel } from '../PrompterPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LINES = linesOf(`Hi, I'm Sam, and today I'll show you how the new pipeline view works.
First, open the deals board from the sidebar.
Every column is a stage, and you can drag a deal between stages.
When you drop a deal into Won, the forecast updates on its own.
Next, let's look at the filters at the top of the board.`)
const ITEMS: ChecklistItem[] = [{ id: 'a', text: 'Open the deals board' }, { id: 'b', text: 'Drag a deal between stages' }, { id: 'c', text: 'Pricing' }]

let root: Root | null = null, host: HTMLElement | null = null
beforeEach(() => { localStorage.clear() })
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

let heard: Heard = NOTHING_HEARD, seq = 0
async function show(following: Following = 'on', lines = LINES, items = ITEMS) {
  heard = NOTHING_HEARD; seq = 0
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<PrompterPanel lines={lines} items={items} heard={heard} following={following} />) })
  return (next: Heard) => act(async () => { heard = next; root!.render(<PrompterPanel lines={lines} items={items} heard={heard} following={following} />) })
}
/** The speaker says `text`: an interim guess of its first half, then the final. */
async function say(rerender: (h: Heard) => Promise<void>, text: string, final = true) {
  const words = text.split(' ').map((t, i) => ({ text: t, startMs: i * 300, endMs: i * 300 + 250 }))
  if (final) await rerender(hear(heard, { sessionId: 's', seq: seq++, final: false, words: words.slice(0, Math.ceil(words.length / 2)) }))
  await rerender(hear(heard, { sessionId: 's', seq: seq++, final, words }))
}
const currentLine = () => document.querySelector('[aria-current="true"]')?.textContent ?? ''
const checkbox = (text: string) => [...document.querySelectorAll('[role="checkbox"]')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement
const text = () => host!.textContent ?? ''

describe('the script', () => {
  it('starts on the first line and follows the speaker', async () => {
    const rerender = await show()
    expect(currentLine()).toContain('Hi, I’m Sam'.replace('’', "'"))
    await say(rerender, 'so first open the deals board')
    expect(currentLine()).toContain('open the deals board')
    await say(rerender, 'every column is a stage')
    await say(rerender, 'and you can drag a deel')
    expect(currentLine()).toContain('Every column is a stage')
    // A line read to its end: the next one is current.
    await say(rerender, 'between stages')
    expect(currentLine()).toContain('When you drop a deal')
    expect(text()).toContain('Following')
  })

  it('moves the highlight on an interim guess before the final', async () => {
    const rerender = await show()
    await say(rerender, 'first open the deals board', false)
    expect(currentLine()).toContain('open the deals board')
  })

  it('pauses following when scrolled by hand, and resumes on Resume', async () => {
    const rerender = await show()
    const view = host!.querySelector('[aria-label="Script lines"]') as HTMLElement
    await act(async () => { view.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })) })
    expect(text()).toContain('Paused')
    const resume = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Resume following')!
    // Words keep being followed while paused: Resume goes to where the speaker is now.
    await say(rerender, 'every column is a stage and you can drag a deal')
    await act(async () => { resume.click() })
    expect(text()).not.toContain('Paused')
    expect(currentLine()).toContain('Every column')
  })

  it('starts at a line the person clicks', async () => {
    await show()
    const fourth = host!.querySelectorAll('[aria-label="Script lines"] p')[3] as HTMLElement
    await act(async () => { fourth.click() })
    expect(currentLine()).toContain('When you drop a deal')
  })

  it('changes the text size, within bounds, and remembers it', async () => {
    await show()
    const view = host!.querySelector('[aria-label="Script lines"]') as HTMLElement
    const before = parseFloat(view.style.fontSize)
    await act(async () => { (host!.querySelector('[aria-label="Bigger text"]') as HTMLButtonElement).click() })
    expect(parseFloat(view.style.fontSize)).toBe(before + 2)
    expect(localStorage.getItem('ni:studio:prompter-text-size')).toBe(String(before + 2))
    for (let i = 0; i < 30; i++) await act(async () => { (host!.querySelector('[aria-label="Smaller text"]') as HTMLButtonElement).click() })
    expect(parseFloat(view.style.fontSize)).toBe(14)
  })

  it('says why it is not following, and shows no following state then', async () => {
    for (const following of ['no-local', 'old-app', 'browser'] as const) {
      await show(following)
      expect(host!.querySelector('[data-testid="prompter-note"]')?.textContent).toBe(followingNote(following))
      expect(host!.querySelector('[role="status"]')).toBeNull()
      act(() => root!.unmount()); host!.remove(); root = null
    }
    expect(followingNote('no-local')).toContain('Local transcription (Settings › Audio)')
    expect(followingNote('on')).toBeNull()
  })
})

describe('the checklist', () => {
  it('checks and unchecks by hand, and marks the next item', async () => {
    await show()
    expect(checkbox('Open the deals board').className).toContain('ring')
    await act(async () => { checkbox('Open the deals board').click() })
    expect(checkbox('Open the deals board').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Drag a deal').className).toContain('ring')
    expect(text()).toContain('1 of 3')
  })

  it('checks an item when it is clearly said, from final words only', async () => {
    const rerender = await show()
    await say(rerender, 'now drag a deal between stages', false)
    expect(checkbox('Drag a deal').getAttribute('aria-checked')).toBe('false')
    await say(rerender, 'now drag a deal between stages')
    expect(checkbox('Drag a deal').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Drag a deal').title).toContain('Checked when you said it')
  })

  it('never checks an item again by itself once the person unchecked it', async () => {
    const rerender = await show()
    await say(rerender, 'open the deals board')
    expect(checkbox('Open the deals board').getAttribute('aria-checked')).toBe('true')
    await act(async () => { checkbox('Open the deals board').click() })
    await say(rerender, 'again open the deals board')
    expect(checkbox('Open the deals board').getAttribute('aria-checked')).toBe('false')
  })

  it('never checks a one-word item by itself', async () => {
    const rerender = await show()
    await say(rerender, 'pricing pricing pricing')
    expect(checkbox('Pricing').getAttribute('aria-checked')).toBe('false')
  })

  it('shows a checklist alone, and a script alone', async () => {
    await show('on', [], ITEMS)
    expect(host!.querySelector('[aria-label="Script"]')).toBeNull()
    expect(host!.querySelector('[aria-label="Checklist"]')).not.toBeNull()
    act(() => root!.unmount()); host!.remove(); root = null
    await show('on', LINES, [])
    expect(host!.querySelector('[aria-label="Checklist"]')).toBeNull()
  })
})
