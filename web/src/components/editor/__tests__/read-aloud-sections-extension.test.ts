// @vitest-environment jsdom
/**
 * The note editor's read-aloud sections (../read-aloud-sections-extension), on
 * a real TipTap editor, with the real section player and the desktop bridge
 * mocked:
 *  - unsupported: hovering dispatches nothing and draws nothing;
 *  - hovering an eligible anchor draws ONE Play widget after its text; a short
 *    section, a plain paragraph, or content streaming in draws none; leaving
 *    the editor clears it;
 *  - Play reads the section; while it plays a Pause widget stays on its anchor
 *    and its top-level blocks carry `read-aloud-reading`; it clears when the
 *    section ends; paused (by its button, or another reader taking the
 *    desktop) a Resume widget stays on its anchor and its blocks carry the
 *    dimmer `read-aloud-paused`, for the most recent pause only; Resume, and
 *    Play on an older paused section, pick up at the sentence it stopped in;
 *  - positions follow edits, and a deleted anchor drops the highlight while
 *    the section reads on; the editor going away pauses its section;
 *  - none of it ever changes the document (no `update`, no undo entry), and a
 *    read-only editor works the same.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Editor, Node as TiptapNode, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { undoDepth } from '@tiptap/pm/history'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

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

import { READ_ALOUD_SECTIONS_KEY, ReadAloudSections } from '../read-aloud-sections-extension'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  playSection,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'

const LONG = 'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.'

const LinkPreview = TiptapNode.create({
  name: 'linkPreview',
  group: 'block',
  atom: true,
  addAttributes: () => ({ url: { default: null } }),
  renderHTML: () => ['div', { 'data-link-preview': '' }],
})

const t = (text: string, bold = false): JSONContent => ({ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) })
const hd = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [t(text)] })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })

const CONTENT: JSONContent = {
  type: 'doc',
  content: [
    p(t('Intro line.')),
    hd(2, 'Plan'),
    p(t(LONG)),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('Book the room'))] }] },
    { type: 'linkPreview', attrs: { url: 'https://dial8.ai' } },
    hd(2, 'Tiny'),
    p(t('Too short to play.')),
    hd(2, 'Wrap-up'),
    p(t('Next steps', true)),
    p(t(`${LONG} Then we regroup.`)),
  ],
}

let host: HTMLDivElement
let editor: Editor
let isStreaming = false
const events = { update: 0, transaction: 0 }

function makeEditor({ editable = true }: { editable?: boolean } = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = new Editor({
    element: host,
    editable,
    extensions: [StarterKit, LinkPreview, ReadAloudSections.configure({ isStreaming: () => isStreaming })],
    content: CONTENT,
  })
  editor.on('update', () => events.update++)
  editor.on('transaction', () => events.transaction++)
  return editor
}

const block = (text: string) =>
  [...editor.view.dom.children].find((el) => el.textContent?.replace(/\s+$/, '') === text) as HTMLElement
const pluginState = () => READ_ALOUD_SECTIONS_KEY.getState(editor.state)!
const widgets = () => [...editor.view.dom.querySelectorAll('[data-read-aloud-section]')] as HTMLButtonElement[]
const reading = () => [...editor.view.dom.querySelectorAll('.read-aloud-reading')].map((el) => el.textContent)
const paused = () => [...editor.view.dom.querySelectorAll('.read-aloud-paused')].map((el) => el.textContent)
const spoken = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { text: string }).text)
const spokenIds = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { id: string }).id)
const kinds = () => widgets().map((w) => w.dataset.readAloudSection)
/** The tracked section being read, as the plugin holds it. */
const playingSection = () => pluginState().tracked.find((t) => t.key === pluginState().playingKey)

function mouseover(el: Element) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function playPlan() {
  mouseover(block('Plan'))
  widgets()[0].click()
  await flush()
}

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  setSectionPlayerSupported(true)
  bridge.calls = []
  bridge.listeners.clear()
  isStreaming = false
  events.update = 0
  events.transaction = 0
})

afterEach(() => {
  if (!editor.isDestroyed) editor.destroy()
  host.remove()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
})

describe('note editor sections — hover', () => {
  it('unsupported: hovering dispatches nothing and draws nothing', () => {
    setSectionPlayerSupported(false)
    makeEditor()
    mouseover(block('Plan'))
    expect(events.transaction).toBe(0)
    expect(widgets()).toEqual([])
    expect(pluginState().hoverPos).toBeNull()
  })

  it('hovering an eligible anchor draws one Play widget after its text', () => {
    makeEditor()
    mouseover(block('Plan'))
    expect(widgets()).toHaveLength(1)
    const [button] = widgets()
    expect(block('Plan').contains(button)).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Play this section')
    expect(button.getAttribute('contenteditable')).toBe('false')
    expect(button.dataset.readAloudSection).toBe('play')
    expect(button.querySelector('svg path')).not.toBeNull()
    expect(bridge.calls).toEqual([['prepare']])
  })

  it('moving within the anchor dispatches nothing more; leaving the editor clears it', () => {
    makeEditor()
    mouseover(block('Plan'))
    const after = events.transaction
    mouseover(widgets()[0])
    mouseover(block('Plan'))
    expect(events.transaction).toBe(after)

    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(pluginState().hoverPos).toBeNull()
    expect(widgets()).toEqual([])
  })

  it('no widget on a short section, a plain paragraph, or an embed', () => {
    makeEditor()
    mouseover(block('Tiny'))
    expect(pluginState().hoverPos).not.toBeNull()
    expect(widgets()).toEqual([])
    mouseover(block('Intro line.'))
    expect(pluginState().hoverPos).toBeNull()
    mouseover(editor.view.dom.querySelector('[data-link-preview]')!)
    expect(pluginState().hoverPos).toBeNull()
    expect(widgets()).toEqual([])
  })

  it('a lead-in paragraph is an anchor too', () => {
    makeEditor()
    mouseover(block('Next steps'))
    expect(widgets()).toHaveLength(1)
    expect(block('Next steps').contains(widgets()[0])).toBe(true)
  })

  it('no Play widget while the content streams in', () => {
    isStreaming = true
    makeEditor()
    mouseover(block('Plan'))
    expect(widgets()).toEqual([])
  })
})

describe('note editor sections — playing', () => {
  it('Play reads the section; Pause stays on the anchor and the section is highlighted', async () => {
    makeEditor()
    await playPlan()
    expect(bridge.calls.find((c) => c[0] !== 'prepare')).toEqual(['cancel'])
    expect(spoken()).toEqual(['Plan.', LONG, 'Book the room.'])
    expect(getSectionPlayerSnapshot().playingKey).toMatch(/^pm:\d+:\d+$/)

    // Leaving the editor: the Pause widget stays.
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(widgets()).toHaveLength(1)
    expect(widgets()[0].getAttribute('aria-label')).toBe('Pause reading')
    expect(kinds()).toEqual(['pause'])
    expect(widgets()[0].querySelectorAll('svg rect')).toHaveLength(2) // lucide's Pause
    expect(block('Plan').contains(widgets()[0])).toBe(true)
    expect(reading()).toHaveLength(4) // Plan, its paragraph, the list, the embed
    expect(block('Tiny').classList.contains('read-aloud-reading')).toBe(false)
  })

  it('never changes the document: no update event, no undo entry', async () => {
    makeEditor()
    const before = editor.getJSON()
    await playPlan()
    mouseover(block('Tiny'))
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(events.transaction).toBeGreaterThan(0)
    expect(events.update).toBe(0)
    expect(editor.getJSON()).toEqual(before)
    expect(undoDepth(editor.state)).toBe(0)
  })

  it('Pause cancels; a Resume widget and a dimmer bar stay without a hover; Resume picks up where it stopped', async () => {
    makeEditor()
    await playPlan()
    const key = getSectionPlayerSnapshot().playingKey!
    for (const cb of [...bridge.listeners]) cb({ id: spokenIds()[1], state: 'speaking' })
    bridge.calls = []
    widgets()[0].click()
    await flush()
    expect(bridge.calls).toEqual([['cancel']])
    expect(getResumePoint(key)).toBe(1)
    expect(reading()).toEqual([])
    expect(paused()).toHaveLength(4)
    expect(kinds()).toEqual(['resume']) // the hovered anchor's own button, once

    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(kinds()).toEqual(['resume'])
    expect(widgets()[0].getAttribute('aria-label')).toBe('Resume this section')
    expect(block('Plan').contains(widgets()[0])).toBe(true)

    bridge.calls = []
    widgets()[0].click()
    await flush()
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(spoken()).toEqual([LONG, 'Book the room.'])
    expect(getSectionPlayerSnapshot().playingKey).toBe(key) // the same anchor, the same key
    expect(reading()).toHaveLength(4)
    expect(paused()).toEqual([])
    expect(kinds()).toEqual(['pause'])
  })

  it('clears when the section finishes; another reader taking the desktop pauses it', async () => {
    makeEditor()
    await playPlan()
    for (const id of spokenIds()) for (const cb of [...bridge.listeners]) cb({ id, state: 'done' })
    expect(reading()).toEqual([])
    expect(paused()).toEqual([])
    expect(kinds()).toEqual(['play']) // still hovered

    await playPlan()
    expect(reading()).toHaveLength(4)
    playSection('md:elsewhere', ['Another surface.'])
    expect(reading()).toEqual([])
    expect(paused()).toHaveLength(4)
    expect(kinds()).toEqual(['resume'])
  })

  it('only the most recent pause keeps its widget and bar; an older paused section resumes from its hover button', async () => {
    makeEditor()
    await playPlan()
    const planKey = getSectionPlayerSnapshot().playingKey!
    for (const cb of [...bridge.listeners]) cb({ id: spokenIds()[2], state: 'speaking' })
    widgets()[0].click() // Pause Plan
    mouseover(block('Wrap-up'))
    widgets().find((w) => block('Wrap-up').contains(w))!.click() // Play Wrap-up
    await flush()
    widgets().find((w) => block('Wrap-up').contains(w))!.click() // Pause Wrap-up
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(widgets()).toHaveLength(1)
    expect(block('Wrap-up').contains(widgets()[0])).toBe(true)
    expect(paused()).toEqual(['Wrap-up', 'Next steps', `${LONG} Then we regroup.`])

    mouseover(block('Plan'))
    const planButton = widgets().find((w) => block('Plan').contains(w))!
    expect(planButton.dataset.readAloudSection).toBe('resume')
    bridge.calls = []
    planButton.click()
    await flush()
    expect(getSectionPlayerSnapshot().playingKey).toBe(planKey)
    expect(spoken()).toEqual(['Book the room.'])
  })

  it('positions follow edits; a deleted anchor drops the highlight while the section reads on', async () => {
    makeEditor()
    await playPlan()
    // Typing before the section moves it.
    editor.commands.insertContentAt(1, 'New ')
    expect(block('New Intro line.')).toBeTruthy()
    expect(reading()).toHaveLength(4)
    expect(block('Plan').contains(widgets()[0])).toBe(true)

    const anchorPos = playingSection()!.anchorPos
    editor.commands.deleteRange({ from: anchorPos, to: anchorPos + editor.state.doc.nodeAt(anchorPos)!.nodeSize })
    expect(reading()).toEqual([])
    expect(widgets()).toEqual([])
    expect(getSectionPlayerSnapshot().playingKey).not.toBeNull()
  })

  it('a paused section whose anchor stops being one (a lead-in losing its bold) loses its Resume', async () => {
    makeEditor()
    mouseover(block('Next steps'))
    widgets()[0].click()
    await flush()
    widgets()[0].click() // Pause
    editor.view.dom.dispatchEvent(new MouseEvent('mouseleave'))
    expect(kinds()).toEqual(['resume'])
    const { anchorPos } = pluginState().tracked[0]
    editor.chain().setTextSelection({ from: anchorPos + 1, to: anchorPos + 1 + 'Next steps'.length }).unsetBold().run()
    expect(pluginState().tracked[0].anchorPos).toBe(anchorPos) // positions unchanged
    expect(widgets()).toEqual([])
    expect(paused()).toEqual([])
  })

  it('read-aloud going away clears everything', async () => {
    makeEditor()
    await playPlan()
    setSectionPlayerSupported(false)
    expect(reading()).toEqual([])
    expect(widgets()).toEqual([])
  })

  it('the editor going away pauses its section', async () => {
    makeEditor()
    await playPlan()
    const key = getSectionPlayerSnapshot().playingKey!
    bridge.calls = []
    editor.destroy()
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(bridge.calls).toEqual([['cancel']])
    expect(getResumePoint(key)).toBe(0)
  })

  it('works the same in a read-only editor', async () => {
    makeEditor({ editable: false })
    await playPlan()
    expect(spoken()).toEqual(['Plan.', LONG, 'Book the room.'])
    expect(widgets()[0].getAttribute('aria-label')).toBe('Pause reading')
  })
})
