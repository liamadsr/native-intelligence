// @vitest-environment jsdom
/**
 * <TeammateChat composer="full"> (bots v4): the teammate's chat in a window of
 * its own (TeammateChatPage, the floating window Open in Dial8 opens) has the
 * MAIN chat's composer instead of the bubble's pill. Pins:
 *   - it is ChatInput: skills from "/", the + menu, and the agent shown dimmed
 *     with why (the teammate is the agent); no model control (the server
 *     picks the model per turn);
 *   - what it adds rides the thread's own send, as the main chat's body: a
 *     "/" skill's id, the turn's system context (no model, no search
 *     settings: the agent picks each search's scope); the files ride the
 *     message;
 *   - it carries no Capture (the app's one is in the top bar);
 *   - photos show dimmed with why: a picked photo is refused in the box,
 *     never uploaded, and no image part ever rides a send (the thread's eve
 *     history would keep its signed link past the link's hour);
 *   - the bubble (no `composer`) keeps its pill.
 * The transport is a scripted stand-in recording each send (its own tests pin the wire).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/app/account/(dashboard)/chat/chat-message', () => ({
  ChatMessage: ({ message }: { message: { role: string; parts: Array<Record<string, unknown>> } }) =>
    h('div', { 'data-role': message.role }, message.parts.map((p) => (p.type === 'text' ? (p.text as string) : '')).join(' ')),
}))
const skillCommands = vi.hoisted(() => [
  { id: 'skill-brief', slug: 'brief', name: 'Brief', icon: null, color: null, description: null, views_context: null },
])
vi.mock('@/app/account/(dashboard)/chat/slash-command-picker', () => ({
  useRecipeCommands: () => skillCommands,
  // The "/" picker, open: a button per skill that picks it.
  SlashCommandPicker: ({ open, onSelect }: { open: boolean; onSelect: (c: (typeof skillCommands)[number]) => void }) =>
    open
      ? h(
          'div',
          { 'data-slash-picker': '' },
          skillCommands.map((c) => h('button', { key: c.id, type: 'button', 'data-pick': c.slug, onClick: () => onSelect(c) }, c.name)),
        )
      : null,
}))
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({
  CaptureBarButton: () => h('button', { type: 'button', 'data-capture-liquid': '' }, 'Capture'),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    // A bot's thread's live bridge for relayed messages (bots v4 A4): subscribes, nothing arrives.
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt-1', user: { id: 'user-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}))

const uploads = vi.hoisted(() => ({ names: [] as string[] }))
vi.mock('@/lib/chat/upload-client', () => ({
  ChatUploadError: class extends Error {},
  uploadChatFile: async (file: File) => {
    uploads.names.push(file.name)
    return { url: `https://storage.test/${file.name}`, storagePath: `user-1/chat-uploads/${file.name}` }
  },
}))

const transports: Array<{ sends: Array<{ body?: unknown; messages: Array<{ parts: unknown[] }> }> }> = []
vi.mock('@/lib/chat/eve/eve-chat-transport', () => ({
  EveChatTransport: class {
    record: { sends: Array<{ body?: unknown; messages: Array<{ parts: unknown[] }> }> }
    constructor() {
      this.record = { sends: [] }
      transports.push(this.record)
    }
    async sendMessages(options: { body?: unknown; messages: Array<{ parts: unknown[] }> }) {
      this.record.sends.push(options)
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start' })
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'On it.' })
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({ type: 'finish' })
          controller.close()
        },
      })
    }
    async reconnectToStream() {
      return null
    }
    async disposeAll() {}
  },
}))

import { TeammateChat } from '../teammate-chat'
import { __resetTeammateChatsForTests, teammateTurnWithoutImages } from '@/hooks/use-teammate-chat'
import { CHAT_PHOTOS_REASON } from '@/components/agent-run/run-chat-copy'

let container: HTMLDivElement
let root: Root

async function flush(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
const okJson = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response

beforeEach(() => {
  transports.length = 0
  uploads.names = []
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/account/chat/eve-session') {
        return okJson({ conversationId: 'conv-tm', workspaceId: 'ws-TM', eveSessionId: null, teammate: { id: 'tm-1', name: 'Writer' } })
      }
      if (url === '/api/account/chat-history/conv-tm') return okJson({ messages: [] })
      return okJson({}, 404)
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  __resetTeammateChatsForTests()
  container.remove()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function mount(props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(h(TeammateChat, { teammateId: 'tm-1', composer: 'full', ...props }))
  })
  await act(async () => {
    await flush()
  })
}

describe('TeammateChat — the full composer', () => {
  it('is the main chat’s composer: skills, the + menu, the agent dimmed with why, no model picker', async () => {
    await mount()
    expect(container.querySelector('[data-teammate-chat-composer="full"]')).toBeTruthy()
    // Skills are a "/" away: no "All skills" button or skill chips above the box.
    expect(container.textContent).not.toContain('All skills')
    expect(container.querySelector('button[aria-label="Add"]')).toBeTruthy()
    expect(container.querySelector('[data-model-picker]')).toBeNull()
    const agent = container.querySelector<HTMLElement>('[data-composer-unavailable="agent"]')!
    expect(agent.textContent).toContain('Writer')
    expect(agent.getAttribute('title')).toContain('Writer is the agent in this chat')
    // No Capture here: the app's one is in the top bar.
    expect(container.querySelector('[data-capture-liquid]')).toBeNull()
  })

  it('a skill picked from "@" goes to the teammate’s own thread with the main chat’s body ("/" in its box is only a character)', async () => {
    await mount()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const typeIn = async (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await typeIn('/')
    expect(container.querySelector('[data-slash-picker]')).toBeNull()
    await typeIn('@')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-slash-picker] [data-pick="brief"]')!.click()
      await flush()
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    expect(transports).toHaveLength(1)
    const send = transports[0].sends.at(-1)!
    expect(send.body).toMatchObject({ skillId: 'skill-brief', systemContext: {} })
    expect(send.body).not.toHaveProperty('model')
    expect(send.body).not.toHaveProperty('agentId')
    expect(container.textContent).toContain('On it.')
  })

  it('a typed turn goes out on Enter with what was typed', async () => {
    await mount()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'draft the follow-up')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    const send = transports[0].sends.at(-1)!
    expect(send.messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'draft the follow-up' }])
    expect(send.body).toMatchObject({ systemContext: {} })
  })

  it('photos show dimmed with why; a picked photo is refused, never uploaded or sent, while a text file goes', async () => {
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click()
    })
    expect(document.body.querySelector('[data-composer-unavailable="photos"]')?.textContent).toContain(CHAT_PHOTOS_REASON)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: [new File(['x'], 'shot.png', { type: 'image/png' }), new File(['# n'], 'notes.md', { type: 'text/markdown' })],
        configurable: true,
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })
    expect(uploads.names).toEqual(['notes.md'])
    expect(container.querySelector(`[title="${CHAT_PHOTOS_REASON}"]`)).toBeTruthy()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'read this')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    const send = transports[0].sends.at(-1)!
    const parts = send.messages.at(-1)!.parts as Array<{ type: string; mediaType?: string; filename?: string }>
    expect(parts.filter((p) => p.type === 'file').map((p) => p.filename)).toEqual(['notes.md'])
    expect(parts.some((p) => p.mediaType?.startsWith('image/'))).toBe(false)
    expect((send.body as { systemContext: { chatFiles: Array<{ fileName: string }> } }).systemContext.chatFiles.map((f) => f.fileName)).toEqual(['notes.md'])
  })

  it('no image ever rides a teammate send, even one handed in past the composer', () => {
    const turn = teammateTurnWithoutImages({
      files: [
        { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'https://storage.test/shot.png' },
        { type: 'file', mediaType: 'text/markdown', filename: 'notes.md', url: 'https://storage.test/notes.md' },
      ],
      chatFiles: [
        { storagePath: 'user-1/chat-uploads/a.png', fileName: 'shot.png', fileSize: 1, mimeType: 'image/png' },
        { storagePath: 'user-1/chat-uploads/b.md', fileName: 'notes.md', fileSize: 1, mimeType: 'text/markdown' },
      ],
      mentions: { noteIds: [], contactIds: [], companyIds: [] },
      skill: null,
      isDesktopClient: false,
    })!
    expect(turn.files.map((f) => f.filename)).toEqual(['notes.md'])
    expect(turn.chatFiles.map((f) => f.fileName)).toEqual(['notes.md'])
    expect(teammateTurnWithoutImages(null)).toBeNull()
  })

  it('the bubble (no composer asked for) keeps its pill', async () => {
    await mount({ composer: undefined })
    expect(container.querySelector('[data-teammate-chat-composer="full"]')).toBeNull()
    expect(container.querySelector('[data-chat-input-root]')).toBeNull()
    expect(container.querySelector('button[aria-label="Send"]')).toBeTruthy()
  })
})
