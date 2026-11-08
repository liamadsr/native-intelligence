// @vitest-environment jsdom
/**
 * ConversationComposer — the main chat's composer for a conversation that
 * isn't the main chat (bots v4: a teammate's thread, a run's chat, in the
 * floating window Open in Native Intelligence opens). It IS ChatInput, fed by the shared
 * composer state, so these pin what this host adds:
 *
 *   - the turn it hands `onSend`: the text, and its extras (the skill, the
 *     files, the mentions; no model: the server picks one per turn; no search
 *     settings: the agent picks each search's scope);
 *   - the armed skill's release (a one-turn skill goes, a sticky one stays),
 *     a skill picked from "/" riding the turn;
 *   - a send that didn't go out gives its text back; a spoken turn comes
 *     through `spokenTurnRef` and leaves the box alone; nothing goes out while
 *     the conversation is still opening;
 *   - what the conversation can't honour shows dimmed, and a press says why;
 *     a photo where it can't take one is refused with the reason (never
 *     uploaded or sent), while text files still go; there is no "My captures"
 *     picker (nor a row above the box for it);
 *   - it carries no Capture (the app's one is in the top bar) and offers no
 *     capture slots (the app's one set is the main composer's).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState, type MutableRefObject } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}) }))
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({
  CaptureBarButton: () => h('button', { type: 'button', 'data-capture-liquid': '' }, 'Capture'),
}))
const skillCommands = vi.hoisted(() => [
  { id: 'skill-brief', slug: 'brief', name: 'Brief', icon: null, color: null, description: null, views_context: null },
  { id: 'skill-prospect-list', slug: 'build-prospect-list', name: 'Build a prospect list', icon: null, color: null, description: null, views_context: null },
])
const MENTIONED_ACTION = vi.hoisted(() => ({ kind: 'action' as const, id: 'a-42', title: 'Pricing page copy', identifier: 'GEN-42', status: 'Todo', score: 1 }))
vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => skillCommands,
  // The "/" picker, open: a button per skill that picks it, and one that
  // mentions an action where the composer can take one.
  SlashCommandPicker: ({
    open,
    onSelect,
    onMentionRecord,
    mentionKinds = [],
  }: {
    open: boolean
    onSelect: (c: (typeof skillCommands)[number]) => void
    onMentionRecord?: (row: typeof MENTIONED_ACTION) => void
    mentionKinds?: readonly string[]
  }) =>
    open
      ? h('div', { 'data-slash-picker': '' }, [
          ...skillCommands.map((c) => h('button', { key: c.id, type: 'button', 'data-pick': c.slug, onClick: () => onSelect(c) }, c.name)),
          mentionKinds.includes('action')
            ? h('button', { key: 'mention', type: 'button', 'data-mention-action': '', onClick: () => onMentionRecord?.(MENTIONED_ACTION) }, 'GEN-42')
            : null,
        ])
      : null,
}))
const uploads = vi.hoisted(() => ({ names: [] as string[] }))
vi.mock('@/lib/chat/upload-client', () => ({
  ChatUploadError: class extends Error {},
  uploadChatFile: async (file: File) => {
    uploads.names.push(file.name)
    return { url: `https://storage.test/${file.name}`, storagePath: `user-1/chat-uploads/${file.name}` }
  },
}))

import { ConversationComposer, type ConversationComposerProps } from '../conversation-composer'
import { ChatInput } from '../chat-input'
import type { ComposerTurnExtras } from '../composer-state'

let container: HTMLDivElement
let root: Root
let sends: Array<{ text: string; extras: ComposerTurnExtras }>
let sendResult: boolean
let lastValue: string

function Harness(props: Partial<ConversationComposerProps> & { initial?: string }) {
  const { initial = '', ...rest } = props
  const [value, setValue] = useState(initial)
  lastValue = value
  return h(ConversationComposer, {
    value,
    onChange: setValue,
    onSend: async (text: string, extras: ComposerTurnExtras) => {
      sends.push({ text, extras })
      return sendResult
    },
    onStop: () => {},
    isLoading: false,
    ...rest,
  })
}

async function render(props: Partial<ConversationComposerProps> & { initial?: string } = {}) {
  await act(async () => {
    root.render(h(Harness, props))
  })
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function enter() {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}
/** Type "@" and pick a skill from the menu (skills are attached with `@`, as anything else). */
async function pickSkill(slug: string) {
  await type('@')
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-slash-picker] [data-pick="${slug}"]`)!.click()
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  uploads.names = []
  sends = []
  sendResult = true
  lastValue = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ConversationComposer — the turn it sends', () => {
  it('hands onSend the text and its extras, then clears the box', async () => {
    await render()
    await type('what did you find?')
    await enter()
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toBe('what did you find?')
    expect(sends[0].extras).toEqual({
      files: [],
      chatFiles: [],
      mentions: { noteIds: [], contactIds: [], companyIds: [] },
      skill: null,
      isDesktopClient: false,
    })
    expect(lastValue).toBe('')
  })

  it('an action mentioned from "@" rides the turn as a record, and comes back if the send fails', async () => {
    sendResult = false
    await render()
    await type('what about @gen')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slash-picker] [data-mention-action]')!.click()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(lastValue).toBe('what about @GEN-42 ')
    await enter()
    expect(sends[0].extras.mentions).toEqual({
      noteIds: [],
      contactIds: [],
      companyIds: [],
      records: [{ kind: 'action', id: 'a-42', title: 'Pricing page copy', identifier: 'GEN-42' }],
    })
    // Not sent: the chip is back for the next try.
    sendResult = true
    await enter()
    expect(sends[1].extras.mentions.records).toEqual([{ kind: 'action', id: 'a-42', title: 'Pricing page copy', identifier: 'GEN-42' }])
  })

  it('shows no model control and carries no model: the server picks one per turn', async () => {
    await render()
    expect(container.querySelector('[data-model-picker]')).toBeNull()
    expect(container.querySelector('[data-testid="model-thinking-picker"]')).toBeNull()
    await type('hello')
    await enter()
    expect(sends[0].extras).not.toHaveProperty('model')
  })

  it('a "/" in its box is only a character: no menu', async () => {
    await render()
    await type('/')
    expect(container.querySelector('[data-slash-picker]')).toBeNull()
  })

  it('a skill picked from "@" rides the turn; a one-turn skill is released after', async () => {
    await render()
    await pickSkill('brief')
    expect(lastValue).toBe('/brief ')
    await enter()
    expect(sends[0].text.trim()).toBe('/brief')
    expect(sends[0].extras.skill).toEqual({ id: 'skill-brief', slug: 'brief', name: 'Brief' })
    // Released: the next turn carries no skill.
    await type('and then?')
    await enter()
    expect(sends[1].extras.skill).toBeNull()
  })

  it('a sticky skill (build-prospect-list) stays armed for the next turn, as in the main chat', async () => {
    await render()
    await pickSkill('build-prospect-list')
    await enter()
    await type('find me ten more')
    await enter()
    expect(sends[1].extras.skill).toEqual({ id: 'skill-prospect-list', slug: 'build-prospect-list', name: 'Build a prospect list' })
  })

  it('a send that didn’t go out gives its text back', async () => {
    sendResult = false
    await render()
    await type('try this')
    await enter()
    expect(sends).toHaveLength(1)
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(lastValue).toBe('try this')
  })

  it('sends nothing while the conversation is still opening, or while a reply streams', async () => {
    await render({ holdSend: true, initial: 'early' })
    await enter()
    expect(sends).toHaveLength(0)
    await render({ isLoading: true, initial: 'mid-reply' })
    await enter()
    expect(sends).toHaveLength(0)
  })

  it('a spoken turn comes through spokenTurnRef with the same extras, and leaves the box alone', async () => {
    const ref: MutableRefObject<((text: string) => Promise<boolean>) | null> = { current: null }
    await render({ spokenTurnRef: ref, initial: 'half-typed' })
    expect(ref.current).toBeTypeOf('function')
    let sent = false
    await act(async () => {
      sent = await ref.current!('read me the summary')
    })
    expect(sent).toBe(true)
    expect(sends[0].text).toBe('read me the summary')
    expect(sends[0].extras).not.toHaveProperty('searchSettings')
    expect(lastValue).toBe('half-typed')
  })
})

describe('ConversationComposer — what it shows', () => {
  it('shows what the conversation can’t honour dimmed, and a press says why', async () => {
    await render({
      unavailable: {
        agent: { label: 'Scout', reason: 'This chat is Scout’s run.' },
      },
    })
    const agent = container.querySelector<HTMLElement>('[data-composer-unavailable="agent"]')!
    expect(agent.textContent).toContain('Scout')
    expect(agent.getAttribute('title')).toBe('This chat is Scout’s run.')
    await act(async () => {
      agent.click()
    })
    expect(document.body.querySelector('[data-composer-unavailable-reason="agent"]')?.textContent).toBe(
      'This chat is Scout’s run.',
    )
  })

  it('carries no Capture and no capture slots, nor does the main composer', async () => {
    await act(async () => {
      root.render(
        h('div', null, [
          h(ChatInput, {
            key: 'main',
            value: '',
            onChange: () => {},
            onSubmit: () => {},
            onStop: () => {},
            isLoading: false,
            attachedNotes: [],
            onAttachNote: () => {},
            onRemoveNote: () => {},
            attachedFiles: [],
            onAttachFiles: () => {},
            onRemoveFile: () => {},
          }),
          h('section', { key: 'floating', 'data-floating': '' }, h(Harness, {})),
        ]),
      )
    })
    const floating = container.querySelector('[data-floating]')!
    expect(floating.querySelector('[data-capture-liquid]')).toBeNull()
    expect(floating.querySelector('[data-capture-controls-slot]')).toBeNull()
    expect(floating.querySelector('[data-capture-pills-slot]')).toBeNull()
    expect(floating.querySelector('[data-capture-voice-id-slot]')).toBeNull()
    // Neither composer carries Capture (it's in the top bar), nor a capture's
    // controls: those are on the capture's own card (one-chat Slice 3).
    expect(container.querySelectorAll('[data-capture-liquid]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-capture-controls-slot]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-capture-voice-id-slot]')).toHaveLength(0)
  })
})

describe('ConversationComposer — photos where the conversation can’t take them, and no "My captures"', () => {
  const PHOTOS = 'Photos can’t be sent in this chat yet. Describe what the photo shows instead.'

  async function pick(...files: File[]) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  }

  it('the + menu shows photos dimmed with the reason, and the picker offers text files only', async () => {
    await render({ unavailable: { photos: { reason: PHOTOS } } })
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.accept).not.toContain('image/')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click()
    })
    const row = document.body.querySelector('[data-composer-unavailable="photos"]')!
    expect(row.textContent).toContain('Photos')
    expect(row.textContent).toContain(PHOTOS)
    expect(document.body.textContent).toContain('Add files')
    expect(document.body.textContent).not.toContain('Add files or photos')
  })

  it('a photo (by name or type) becomes an error chip with the reason, never uploaded or sent; a text file still goes', async () => {
    await render({ unavailable: { photos: { reason: PHOTOS } } })
    await pick(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      new File(['x'], 'screenshot', { type: 'image/jpeg' }),
      new File(['# notes'], 'notes.md', { type: 'text/markdown' }),
    )
    expect(uploads.names).toEqual(['notes.md'])
    const refused = [...container.querySelectorAll<HTMLElement>('[title]')].filter((el) => el.getAttribute('title') === PHOTOS)
    expect(refused).toHaveLength(2)
    await type('summarise this')
    await enter()
    expect(sends).toHaveLength(1)
    expect(sends[0].extras.chatFiles.map((f) => f.fileName)).toEqual(['notes.md'])
    expect(sends[0].extras.files.map((f) => f.filename)).toEqual(['notes.md'])
  })

  it('a conversation that takes photos (none named unavailable) uploads them as the main chat does', async () => {
    await render()
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toContain('image/*')
    await pick(new File(['x'], 'shot.png', { type: 'image/png' }))
    expect(uploads.names).toEqual(['shot.png'])
  })

  it('renders no "My captures" picker, focused and typing or not: the agent picks each search\'s scope', async () => {
    await render()
    await act(async () => {
      textarea().focus()
      textarea().dispatchEvent(new FocusEvent('focus', { bubbles: true }))
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    await type('hello')
    expect(container.textContent).not.toContain('My captures')
    expect(container.querySelector('[data-composer-unavailable="searchSettings"]')).toBeNull()
  })
})
