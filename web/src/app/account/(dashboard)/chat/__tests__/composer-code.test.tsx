// @vitest-environment jsdom
/**
 * The main composer's Chat / Code tabs (composer-code.tsx over ChatInput and
 * the message list), against a fake of the routes:
 *
 *   - a person with no Mac environment gets no tabs: the composer as ever;
 *   - with a Mac, Chat is in front and nothing about agents shows (the old
 *     worker toggle is gone);
 *   - Code: the agent picker before the mic (the Mac's saved worker as the
 *     default), its sections (Native Intelligence, Your agents, Needs
 *     connection with how to connect one), the folder after the environment,
 *     no "+";
 *   - a send starts the job (POST /api/local-agent/sessions, the person's own
 *     words, the picked agent, the folder), clears the box, keeps the choice
 *     for the conversation, OPENS the job's own view (the Agents panel's
 *     way, by its turn's ledger row), and the thread draws it as one compact
 *     line, never a bubble or the job itself;
 *   - a second send while that job is open on the same agent in the same
 *     folder is refused with a sentence and an Open button (follow-ups go in
 *     its own chat); another folder starts another job;
 *   - a refusal keeps the words and says why; a cloud environment says the
 *     cloud comes next and sends nothing;
 *   - a conversation with a Code job opens on Code with that job's agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { __resetCodeViewForTests, getCodeView, selectCodeChat, setCodeChatLive } from '../code-chat-live'
import { CodeHeldRow } from '../composer-code-controls'
import { __resetCurrentChatForTests, backToAgent, currentChatKind, getCurrentChat, openCodingChat } from '../current-chat-store'
import { getSidePanelState } from '../../side-panels/side-panel-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}) }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))
vi.mock('../chat-message', () => ({ ChatMessage: ({ message }: { message: { id: string } }) => h('div', { 'data-msg-id': message.id }) }))

import { ChatInput } from '../chat-input'
import { toMentionContact } from '@/lib/search/menu-search'

import { ChatMessageList } from '../chat-message-list'
import { useComposerEnvironment, useComposerFolders } from '../composer-state'
import { useComposerCode, useThreadHasCode } from '../composer-code'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { CODE_TAB_STORAGE_PREFIX } from '@/lib/local-agent/code-tab'
import { CODE_CLOUD_NEXT_REASON } from '@/lib/local-agent/code-thread'
import { cloud, fakeFetch, json, mac, type FakeRoute } from '@/components/environments/__tests__/fixtures'

const CONV = 'c0de0000-0000-4000-8000-000000000001'
const STUDIO = mac({
  id: 'env-studio',
  name: 'Studio Mac',
  deviceName: 'Studio Mac',
  deviceId: 'dev-studio',
  worker: 'claude-code',
  offeredWorkers: [{ id: 'claude-code', label: 'Claude Code' }],
  folders: [
    { id: 'f-site', label: 'harbor-site', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: 'harbor/site' },
    { id: 'f-notes', label: 'notes', mode: 'read', isGit: false, baseBranch: null, repoFullName: null },
  ],
})

const session = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1', folderId: 'f-site', folderLabel: 'harbor-site', deviceId: 'dev-studio', deviceName: 'Studio Mac', conversationId: CONV,
  mode: 'edit', request: 'Fix the date picker', status: 'queued', lastSignal: null, lastSignalText: null, branch: null, commitSha: null, error: null,
  trackedJobId: 'tj-1', createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', endedAt: null, lastDeviceSeq: null, startedBy: 'person',
  worker: 'claude-code', codeRequestId: 'req-x', ...over,
})

const host = { messages: [] as UIMessage[], value: '' }
/** The job views opened (by their turn's ledger row), as the Agents panel opens one. */
const opened: string[] = []

const hostOpts = { conversation: CONV as string | null, notes: [] as Array<{ id: string; title: string }> }

function Host({ initial = [] as UIMessage[], layout = 'inline' as 'inline' | 'stacked' }) {
  const env = useComposerEnvironment({ enabled: true, conversationId: CONV })
  const folders = useComposerFolders({ enabled: false })
  const [messages, setMessages] = useState<UIMessage[]>(initial)
  const [value, setValue] = useState('')
  const code = useComposerCode({
    enabled: true,
    conversationId: CONV,
    environment: env,
    folders,
    messages,
    appendMessage: (m) => setMessages((prev) => [...prev, m]),
    conversationIdNow: async () => hostOpts.conversation,
    chatBusy: () => false,
    openWorkItem: (id: string) => void opened.push(id),
    clearWords: (words) => setValue((cur) => (cur.trim() === words ? '' : cur)),
  })
  // What the host holds, for the tests to read after each act().
  useEffect(() => {
    host.messages = messages
    host.value = value
  })
  return h(
    'div',
    null,
    h(ChatMessageList, { messages, latestUserMessageId: null, userAvatarUrl: null, userInitials: 'AR', codeThread: code.thread }),
    // As chat-panel.tsx draws it: the Code message held while its chat works, Edit putting it back.
    code.active && code.held
      ? h(CodeHeldRow, {
          held: code.held,
          onSendNow: code.sendHeldNow,
          onEdit: () => {
            const text = code.takeHeld()
            if (text) setValue(text)
          },
        })
      : null,
    h(ChatInput, {
      value,
      onChange: setValue,
      onSubmit: () => {
        if (code.active) void code.submit(value).then((sent) => sent && setValue(''))
      },
      onStop: () => {},
      isLoading: false,
      attachedNotes: hostOpts.notes as never,
      attachedContacts: [],
      onAttachContact: () => {},
      onRemoveContact: () => {},
      attachedRecords: [],
      onAttachRecord: () => {},
      onRemoveRecord: () => {},
      onAttachNote: () => {},
      onRemoveNote: () => {},
      attachedFiles: [],
      onAttachFiles: () => {},
      onRemoveFile: () => {},
      environment: env,
      folders,
      code: code.code,
      layout,
    }),
  )
}

let container: HTMLDivElement
let root: Root
let f: ReturnType<typeof fakeFetch>
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement
function type(text: string) {
  act(() => {
    setter.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (el: HTMLElement) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })))
/** Radix menus open on pointerdown. */
const openMenu = async (sel: string) => {
  await act(async () => {
    q(sel)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
  })
  await flush()
}
const send = async () => {
  press(q('button[aria-label^="Send"]')!)
  await flush()
}
const posts = () => f.calls.filter((c) => c.method === 'POST')

async function mount(opts: { list: unknown[]; chatEnv: unknown; routes?: FakeRoute[]; initial?: UIMessage[]; layout?: 'inline' | 'stacked' }) {
  f = fakeFetch({ list: opts.list, chat: { environmentId: (opts.chatEnv as { id?: string } | null)?.id ?? null, source: 'chat', environment: opts.chatEnv } }, opts.routes ?? [])
  configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
  vi.stubGlobal('fetch', f.fn)
  await act(async () => root.render(h(Host, { initial: opts.initial ?? [], layout: opts.layout ?? 'inline' })))
  await flush()
}

beforeEach(() => {
  opened.length = 0
  __resetCodeViewForTests()
  __resetCurrentChatForTests()
  sessionStorage.clear()
  hostOpts.conversation = CONV
  hostOpts.notes = []
  resetEnvironmentStore()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  configureEnvironment(null)
  vi.unstubAllGlobals()
})

describe('who sees the tabs', () => {
  it('no Mac environment: no tabs, no agent picker; the composer as ever', async () => {
    await mount({ list: [cloud()], chatEnv: cloud() })
    expect(q('[data-composer-tabs]')).toBeNull()
    expect(q('[data-code-agent-picker]')).toBeNull()
    expect(q('[data-environment-selector]')).not.toBeNull()
    expect(q('button[aria-label="Add"]')).not.toBeNull()
  })

  it('a Mac: Chat in front, nothing about agents (the worker toggle is gone)', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    expect(q('[data-composer-tab="chat"]')!.getAttribute('data-state')).toBe('on')
    // The chat tab carries the agent's name: the default until the person names it.
    expect(q('[data-composer-tab="chat"]')!.textContent).toBe('Joseph')
    expect(q('[data-composer-tab="chat"]')!.getAttribute('aria-label')).toBe('Chat with Joseph')
    expect(q('[data-composer-tabs]')!.getAttribute('role')).toBe('radiogroup')
    expect(q('[data-code-agent-picker]')).toBeNull()
    expect(q('[data-worker-toggle]')).toBeNull()
    expect(q('[data-code-folder-picker]')).toBeNull()
  })
})

describe('the toggle is Home’s current chat', () => {
  it('a coding chat opened from outside the composer (a Recent row) moves the toggle to Code: the box never stays on the agent under it', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    expect(q('[data-composer-tab="chat"]')!.getAttribute('data-state')).toBe('on')
    act(() => openCodingChat('sess-1', { from: 'recents' }))
    await flush()
    expect(q('[data-composer-tab="code"]')!.getAttribute('data-state')).toBe('on')
    expect(currentChatKind()).toBe('code')
    expect(getSidePanelState().chatKind).toBe('code')
  })

  it('Code starts a new coding chat in place, and the agent’s side goes back', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(currentChatKind()).toBe('code-new')
    press(q('[data-composer-tab="chat"]')!)
    await flush()
    expect(currentChatKind()).toBe('agent')
    expect(getSidePanelState().chatKind).toBe('agent')
  })

  it('Code pressed with a coding chat open starts a new one, never that chat again (the toggle starts, Recent resumes)', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    act(() => openCodingChat('sess-1', { from: 'recents' }))
    await flush()
    press(q('[data-composer-tab="chat"]')!)
    await flush()
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(getCurrentChat()).toEqual({ kind: 'code-new' })
    expect(getCodeView().selected).toBeNull()
  })

  it('a conversation’s saved tab is no longer a mode: it opens on the agent whatever it says', async () => {
    localStorage.setItem(`${CODE_TAB_STORAGE_PREFIX}${CONV}`, JSON.stringify({ tab: 'code', agent: null, folderId: 'f-site' }))
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    expect(q('[data-composer-tab="chat"]')!.getAttribute('data-state')).toBe('on')
    expect(currentChatKind()).toBe('agent')
    // The agent it kept (Native Intelligence, not the Mac's saved worker) is still what a new coding chat starts with.
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-agent-picker]')!.getAttribute('data-code-agent-picker')).toBe('native')
    expect(q('[data-code-folder-picker]')!.getAttribute('data-code-folder-picker')).toBe('f-site')
  })
})

describe('the Code tab', () => {
  it('the agent picker before the mic (the Mac’s saved worker), the folder after the environment, no “+”', async () => {
    // A field wide enough to show its placeholder (jsdom lays nothing out).
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-composer-tab="code"]')!.getAttribute('data-state')).toBe('on')
    expect(q('[data-code-agent-picker]')!.getAttribute('data-code-agent-picker')).toBe('claude-code')
    expect(q('[data-code-folder-picker]')!.getAttribute('data-code-folder-picker')).toBe('f-site')
    expect(q('button[aria-label="Add"]')).toBeNull()
    expect(textarea().placeholder).toBe('Tell Claude Code what to change')
    width.mockRestore()
    // The under-row: the tabs, then the environment, then the folder.
    const row = q('[data-composer-under-row]')!
    const order = [...row.querySelectorAll('[data-composer-tabs], [data-environment-selector], [data-code-folder-picker]')].map((el) =>
      el.hasAttribute('data-composer-tabs') ? 'tabs' : el.hasAttribute('data-environment-selector') ? 'environment' : 'folder',
    )
    expect(order).toEqual(['tabs', 'environment', 'folder'])
  })

  it('a plain click on the agent picker opens it and it stays open: the click never reaches the box that focuses the field', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    // A real click is a pointerdown (the menu opens) and then a click on the same button.
    await openMenu('[data-code-agent-picker]')
    press(q('[data-code-agent-picker]')!)
    await flush()
    expect(q('[data-code-agent-menu]')).not.toBeNull()
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA')
  })

  it('the picker: Native Intelligence, Your agents, and Needs connection with how to connect one', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    await openMenu('[data-code-agent-picker]')
    const menu = q('[data-code-agent-menu]')!
    expect([...menu.querySelectorAll('[data-code-agent-option]')].map((el) => el.getAttribute('data-code-agent-option'))).toEqual(['native', 'claude-code'])
    expect(menu.textContent).toContain('Your agents')
    expect(menu.textContent).toContain('Needs connection')
    expect(q('[data-code-agent-needs-connection="codex"]')!.getAttribute('data-disabled')).not.toBeNull()
    expect(q('[data-code-agent-connect-hint]')!.textContent).toContain('Install it and sign in on Studio Mac, then allow it from the Native Intelligence menu bar icon')
  })

  it('a send starts the job with the person’s words, clears the box, keeps the choice, opens its own view, and the thread shows one compact line', async () => {
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker on the booking page')
    await send()
    const start = posts().find((c) => c.url === '/api/local-agent/sessions')!
    expect(start.body).toMatchObject({ conversationId: CONV, folderId: 'f-site', request: 'Fix the date picker on the booking page', worker: 'claude-code', environmentId: 'env-studio' })
    const requestId = (start.body as { requestId: string }).requestId
    expect(host.messages).toHaveLength(1)
    // The row names its job, agent and folder from the start: its line never waits on a read.
    expect(host.messages[0]).toMatchObject({
      id: `code-${requestId}`,
      role: 'user',
      metadata: { local_agent_code: { requestId, sessionId: 'sess-1', start: true, worker: 'claude-code', folder: 'harbor-site' } },
    })
    expect(host.value).toBe('')
    expect(JSON.parse(localStorage.getItem(`${CODE_TAB_STORAGE_PREFIX}${CONV}`)!)).toEqual({ tab: 'code', agent: 'claude-code', folderId: 'f-site' })
    // The person lands in the job's own chat, in the dashboard: it is the Code view's selected chat (not its page).
    expect(getCodeView().selected).toBe('sess-1')
    expect(opened).toEqual([])
    // The thread: one compact line in place of the request, no bubble with its words.
    const row = q(`[data-message-row="code-${requestId}"]`)!
    expect(row.getAttribute('data-message-role')).toBe('code')
    expect(row.querySelector('[data-code-line-title]')!.textContent).toBe('Claude Code in harbor-site')
    expect(row.querySelector('[data-code-line-status]')!.textContent).toBe('Starting')
    // A short excerpt of the request, on the line itself (no bubble with the words).
    expect(row.querySelector('[data-code-line-excerpt]')!.textContent).toBe('Fix the date picker on the booking page')
    expect(row.querySelector('[data-message-role="user"]')).toBeNull()
    press(row.querySelector('button')!)
    expect(getCodeView().selected).toBe('sess-1')
  })

  it('a send while the chat on screen is still being read is held: never a new chat', async () => {
    let started = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: () => json({ session: session({ id: `sess-${++started}` }), created: true, joined: false, deviceOnline: true }, 201) }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    selectCodeChat('sess-loading')
    type('Carry on with the picker')
    await send()
    expect(started).toBe(0)
    expect(host.value).toBe('Carry on with the picker')
    expect(q('[data-code-notice="send"]')!.textContent).toContain('still loading')
  })

  it('our own agent picked: worker null', async () => {
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ worker: null, codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    await openMenu('[data-code-agent-picker]')
    press(q('[data-code-agent-option="native"]')!)
    await flush()
    expect(q('[data-code-agent-picker]')!.getAttribute('data-code-agent-picker')).toBe('native')
    type('Look at the build')
    await send()
    expect(posts().find((c) => c.url === '/api/local-agent/sessions')!.body).toMatchObject({ worker: null })
  })

  it('a refusal keeps the words in the box and says why under it', async () => {
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: () => json({ error: 'Native Intelligence on Studio Mac is already working in harbor-site for another chat.', code: 'FOLDER_BUSY' }, 409) }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix it')
    await send()
    expect(host.value).toBe('Fix it')
    expect(host.messages).toHaveLength(0)
    expect(q('[data-code-notice]')!.textContent).toBe('Native Intelligence on Studio Mac is already working in harbor-site for another chat.')
  })

  it('a cloud environment: the line says the cloud comes next, send is off, nothing is sent', async () => {
    await mount({ list: [STUDIO, cloud()], chatEnv: cloud() })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-notice="blocker"]')!.textContent).toBe(CODE_CLOUD_NEXT_REASON)
    // No Mac to pick an agent on: no picker.
    expect(q('[data-code-agent-picker]')).toBeNull()
    type('Fix it')
    expect((q('button[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(true)
    expect(posts()).toEqual([])
  })

  it('a second send while that job is open (same agent, same folder) is refused with an Open button; nothing is sent; another folder starts another job', async () => {
    let started = 0
    const twoFolders = { ...STUDIO, folders: [...STUDIO.folders, { id: 'f-api', label: 'harbor-api', mode: 'edit' as const, isGit: true, baseBranch: 'main', repoFullName: 'harbor/api' }] }
    await mount({
      list: [twoFolders],
      chatEnv: twoFolders,
      routes: [
        // The fresh read before refusing: still open.
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ session: session({ status: 'running', codeRequestId: 'req-1' }), events: [], lastId: 0 }) },
        { method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ id: `sess-${++started}`, trackedJobId: `tj-${started}`, folderId: (body as { folderId: string }).folderId, status: 'running', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    expect(started).toBe(1)
    // "New chat" picked: no chat is on screen to take the words.
    selectCodeChat(null)
    type('And add a test for it')
    await send()
    expect(started).toBe(1)
    expect(posts().filter((c) => c.url.includes('/messages'))).toEqual([])
    expect(host.value).toBe('And add a test for it')
    expect(host.messages).toHaveLength(1)
    const notice = q('[data-code-notice="send"]')!
    expect(notice.textContent).toContain('Claude Code is already working in harbor-site: open it to continue.')
    // Working: Open it, and nothing else (no new job beside a working one).
    expect([...notice.querySelectorAll('[data-code-notice-action]')].map((b) => b.textContent)).toEqual(['Open it'])
    press(q('[data-code-notice-action="open"]')!)
    expect(getCodeView().selected).toBe('sess-1')
    // Another folder: another job.
    await openMenu('[data-code-folder-picker]')
    press(q('[data-code-folder-option="f-api"]')!)
    await flush()
    selectCodeChat(null)
    type('Bump the API client')
    await send()
    expect(started).toBe(2)
  })

  it('a second send while it asks the person: refused with Open it to answer, no new job offered', async () => {
    let started = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ session: session({ status: 'waiting', lastSignal: 'ask', codeRequestId: 'req-1' }), events: [], lastId: 0 }) },
        { method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ id: `sess-${++started}`, status: 'running', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    // "New chat" picked: no chat is on screen to take the words.
    selectCodeChat(null)
    type('Today’s month')
    await send()
    expect(started).toBe(1)
    expect(host.value).toBe('Today’s month')
    const notice = q('[data-code-notice="send"]')!
    expect(notice.textContent).toContain('Claude Code is waiting for your answer in harbor-site: open it to answer.')
    expect([...notice.querySelectorAll('[data-code-notice-action]')].map((b) => b.getAttribute('data-code-notice-action'))).toEqual(['open'])
  })

  it('a second send while it is idle after a finished turn: one line, Open it to continue or Start a new job (which ends the idle one)', async () => {
    let started = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ session: session({ status: 'waiting', lastSignal: 'finish', codeRequestId: 'req-1' }), events: [], lastId: 0 }) },
        {
          method: 'POST',
          url: '/api/local-agent/sessions',
          reply: (body) => json({ session: session({ id: `sess-${++started}`, trackedJobId: `tj-${started}`, status: 'queued', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201),
        },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    expect(started).toBe(1)
    // "New chat" picked: no chat is on screen to take the words.
    selectCodeChat(null)
    type('Now the time picker')
    await send()
    expect(started).toBe(1)
    expect(host.value).toBe('Now the time picker')
    const notice = q('[data-code-notice="send"]')!
    expect(notice.textContent).toContain('Claude Code finished in harbor-site, and that job is still open.')
    expect([...notice.querySelectorAll('[data-code-notice-action]')].map((b) => b.textContent)).toEqual(['Open it to continue', 'Start a new job'])
    // Open it to continue: its own chat.
    press(q('[data-code-notice-action="open"]')!)
    expect(getCodeView().selected).toBe('sess-1')
    // Start a new job: the server ends the idle one (newJob), the new one opens, the words leave the box.
    press(q('[data-code-notice-action="new"]')!)
    await flush()
    expect(started).toBe(2)
    expect(posts().filter((c) => c.url === '/api/local-agent/sessions').at(-1)!.body).toMatchObject({ request: 'Now the time picker', newJob: true })
    expect(host.value).toBe('')
    expect(host.messages).toHaveLength(2)
    expect(getCodeView().selected).toBe('sess-2')
    expect(q('[data-code-notice="send"]')).toBeNull()
    // Two jobs, two lines.
    expect(document.querySelectorAll('[data-code-line]')).toHaveLength(2)
  })

  it('a re-check that fails refuses on what was known: the words stay, nothing is sent, Open it still opens', async () => {
    let started = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ error: 'down' }, 500) },
        { method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ id: `sess-${++started}`, status: 'running', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    // "New chat" picked: no chat is on screen to take the words.
    selectCodeChat(null)
    type('And add a test for it')
    await send()
    expect(started).toBe(1)
    expect(host.value).toBe('And add a test for it')
    expect(host.messages).toHaveLength(1)
    expect(q('[data-code-notice="send"]')!.textContent).toContain('Claude Code is already working in harbor-site: open it to continue.')
    press(q('[data-code-notice-action="open"]')!)
    expect(getCodeView().selected).toBe('sess-1')
  })

  it('no turn row known (no trackedJobId): Open reads the job by its session and opens its current turn', async () => {
    let started = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [
        // Read by its session: it names its current turn's row now.
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ session: session({ status: 'running', trackedJobId: 'tj-late', codeRequestId: 'req-1' }), events: [], lastId: 0 }) },
        { method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ id: `sess-${++started}`, trackedJobId: null, status: 'queued', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    // The send opens it all the same, by its session.
    expect(getCodeView().selected).toBe('sess-1')
    // "New chat" picked: no chat is on screen to take the words.
    selectCodeChat(null)
    type('And add a test for it')
    await send()
    press(q('[data-code-notice-action="open"]')!)
    await flush()
    expect(getCodeView().selected).toBe('sess-1')
  })

  it('a line whose job the list doesn’t hold (or hasn’t read) still names its agent and folder, and opens by its session', async () => {
    const started: UIMessage = {
      id: 'code-req-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Fix the date picker' }],
      metadata: { local_agent_code: { requestId: 'req-1', sessionId: 'sess-1', start: true, worker: 'claude-code', folder: 'harbor-site' } },
    }
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      initial: [started],
      routes: [
        { url: `/api/local-agent/sessions?conversationId=${CONV}`, reply: () => json({ sessions: [] }) },
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ session: session({ status: 'waiting', codeRequestId: 'req-1', trackedJobId: 'tj-9' }), events: [], lastId: 0 }) },
      ],
    })
    const line = q('[data-code-line="sess-1"]')!
    expect(line.querySelector('[data-code-line-title]')!.textContent).toBe('Claude Code in harbor-site')
    expect(line.querySelector('[data-code-line-excerpt]')!.textContent).toBe('Fix the date picker')
    press(line.querySelector('button')!)
    await flush()
    expect(getCodeView().selected).toBe('sess-1')
  })

  it('a second send to a job that has ended since: a new job, after one read to be sure', async () => {
    let started = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [
        { url: '/api/local-agent/sessions/sess-1', reply: () => json({ session: session({ status: 'expired', codeRequestId: 'req-1' }), events: [], lastId: 0 }) },
        { method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ id: `sess-${++started}`, status: 'waiting', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    // "New chat" picked: no chat is on screen to take the words.
    selectCodeChat(null)
    type('Now the time picker')
    await send()
    expect(started).toBe(2)
  })

  it('a conversation with a Code job opens on the agent, draws the job as its line, and a new coding chat there starts with that job’s agent', async () => {
    const started: UIMessage = { id: 'code-req-1', role: 'user', parts: [{ type: 'text', text: 'Fix it' }], metadata: { local_agent_code: { requestId: 'req-1' } } }
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      initial: [started],
      routes: [{ url: `/api/local-agent/sessions?conversationId=${CONV}`, reply: () => json({ sessions: [session({ worker: null, codeRequestId: 'req-1', status: 'waiting' })] }) }],
    })
    expect(q('[data-composer-tab="chat"]')!.getAttribute('data-state')).toBe('on')
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-agent-picker]')!.getAttribute('data-code-agent-picker')).toBe('native')
    // Its line, with the job's state as the list read it (finished, idle).
    expect(q('[data-code-line="sess-1"]')!.getAttribute('data-code-line-state')).toBe('done')
    expect(q('[data-code-line-title]')!.textContent).toBe('Native Intelligence in harbor-site')
  })

  it('a stored choice wins, and Chat sends nothing to the coding agent', async () => {
    localStorage.setItem(`${CODE_TAB_STORAGE_PREFIX}${CONV}`, JSON.stringify({ tab: 'chat', agent: null, folderId: null }))
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    expect(q('[data-composer-tab="chat"]')!.getAttribute('data-state')).toBe('on')
    type('Hello')
    await send()
    expect(posts()).toEqual([])
  })
})

describe('a send, done once and leaving nothing behind', () => {
  it('two sends before the first answers: one job, one message', async () => {
    let answer: (r: Response) => void = () => {}
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: () => new Promise<Response>((r) => (answer = r)) as never }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    const sendButton = q('button[aria-label^="Send"]')!
    // Two presses in the same tick: the second sees the first in flight.
    act(() => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
    await flush()
    answer(json({ session: session(), created: true, joined: false, deviceOnline: true }, 201))
    await flush()
    expect(posts().filter((c) => c.url === '/api/local-agent/sessions')).toHaveLength(1)
  })

  it('a chat with no conversation yet: nothing is saved or started, the words stay, the line says so', async () => {
    hostOpts.conversation = null
    await mount({ list: [STUDIO], chatEnv: STUDIO })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    expect(posts()).toEqual([])
    expect(host.messages).toEqual([])
    expect(host.value).toBe('Fix the date picker')
    expect(q('[data-code-notice="send"]')!.textContent).toContain('nothing was sent')
  })

  it('a refused start leaves no message of theirs in the thread (nothing the Chat agent could read as a request)', async () => {
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: () => json({ error: 'harbor-site isn’t a git repository.', code: 'NOT_A_REPOSITORY' }, 409) }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix it')
    await send()
    expect(host.messages).toEqual([])
    expect(host.value).toBe('Fix it')
  })
})

describe('the Code tab sends words only, and says so', () => {
  it('no `@` menu; something staged for Chat (a mention, a file, a skill) gets one plain line', async () => {
    hostOpts.notes = [{ id: 'cap-1', title: 'Booking review' }]
    const person = { id: 'c-ana', full_name: 'Ana Ruiz', email: 'ana@harbor.test', job_title: null, member_id: null, company: null }
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [{ url: '/api/account/search', reply: () => json({ query: '', results: { contact: [{ kind: 'contact', contact: toMentionContact(person), score: 1 }] } }) }],
    })
    const slash = async () => {
      act(() => textarea().focus())
      act(() => {
        const ta = textarea()
        const { selectionStart: st, selectionEnd: en, value } = ta
        setter.call(ta, value.slice(0, st) + '@' + value.slice(en))
        ta.setSelectionRange(st + 1, st + 1)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200))
      })
    }
    // In Chat, `@` opens the menu (mentions; `/` in the box is only a character, skills are the palette's).
    await slash()
    expect(document.querySelector('[data-command-menu="inline"]')).not.toBeNull()
    type('')
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-notice="staged"]')!.textContent).toBe('The coding agent gets your words only. What’s attached above stays for Chat.')
    await slash()
    expect(document.querySelector('[data-command-menu="inline"]')).toBeNull()
  })
})

describe('finding a Code message costs little while a reply streams', () => {
  const reads = { n: 0 }
  const msg = (id: string, code = false): UIMessage => {
    const meta = code ? { local_agent_code: { requestId: id } } : {}
    const m = { id, role: 'user', parts: [] } as unknown as UIMessage
    Object.defineProperty(m, 'metadata', { get: () => (reads.n++, meta), enumerable: true })
    return m
  }
  const seen: boolean[] = []
  function Probe({ messages }: { messages: UIMessage[] }) {
    const has = useThreadHasCode(messages, true)
    useEffect(() => {
      seen.push(has)
    })
    return null
  }
  const render = (messages: UIMessage[]) => act(() => root.render(h(Probe, { messages })))

  it('reads only what is new (and the last one again), stays found, and reads a different thread again', () => {
    seen.length = 0
    const thread = Array.from({ length: 200 }, (_, i) => msg(`m${i}`))
    reads.n = 0
    render(thread)
    expect(seen.at(-1)).toBe(false)
    expect(reads.n).toBe(200)
    // A streamed chunk: the same messages, the last one changed. One read, not 200.
    reads.n = 0
    render([...thread.slice(0, -1), msg('m199')])
    expect(reads.n).toBe(1)
    // A Code message arrives: found; then nothing more is read while it stays the same thread.
    render([...thread, msg('code-1', true)])
    expect(seen.at(-1)).toBe(true)
    reads.n = 0
    render([...thread, msg('code-1', true), msg('a1')])
    expect(reads.n).toBe(0)
    expect(seen.at(-1)).toBe(true)
    // Another conversation: read again from the start.
    render([msg('x0'), msg('x1')])
    expect(seen.at(-1)).toBe(false)
  })
})

describe('a message to the open chat while its agent works (Liam, 11-20: as the main chat, no Steer / Queue)', () => {
  const MESSAGES = '/api/local-agent/sessions/sess-open/messages'
  /** The Code view on an open chat whose agent is `status`, its reader's send a spy. */
  async function onOpenChat(status: string, routes: FakeRoute[] = []) {
    await mount({ list: [STUDIO], chatEnv: STUDIO, routes })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    const live = { session: session({ id: 'sess-open', status }), stopping: false, send: vi.fn(async () => ({ ok: true as const })), stop: vi.fn() }
    act(() => {
      selectCodeChat('sess-open')
      setCodeChatLive('sess-open', live as never)
    })
    await flush()
    return live
  }
  const turnEnds = async (live: { session: Record<string, unknown> }) => {
    act(() => setCodeChatLive('sess-open', { ...live, session: { ...live.session, status: 'waiting' } } as never))
    await flush()
  }

  it('no Steer / Queue choice; sent while it works, it waits under the box, then goes as the next turn when the turn ends', async () => {
    const live = await onOpenChat('running')
    expect(q('[data-code-policy]')).toBeNull()
    type('Also cover the empty state')
    await send()
    expect(live.send).not.toHaveBeenCalled()
    expect(host.value).toBe('')
    expect(q('[data-code-held]')!.getAttribute('data-code-held')).toBe('waiting')
    expect(q('[data-code-held]')!.textContent).toContain('Sends when this turn finishes')
    expect(q('[data-code-held-text]')!.textContent).toBe('Also cover the empty state')
    // A second one joins it.
    type('And the error state')
    await send()
    expect(q('[data-code-held-text]')!.textContent).toBe('Also cover the empty state\n\nAnd the error state')
    await turnEnds(live)
    expect(live.send).toHaveBeenCalledTimes(1)
    expect(live.send).toHaveBeenCalledWith('Also cover the empty state\n\nAnd the error state', 'queue', expect.any(String))
    expect(q('[data-code-held]')).toBeNull()
  })

  it('Send now hands it to the agent mid-turn (a steer)', async () => {
    const live = await onOpenChat('running')
    type('Use the new token instead')
    await send()
    press(q('[data-code-held-send-now]')!)
    await flush()
    expect(live.send).toHaveBeenCalledWith('Use the new token instead', 'steer', expect.any(String))
    expect(q('[data-code-held]')).toBeNull()
    // The turn ending later sends nothing more.
    await turnEnds(live)
    expect(live.send).toHaveBeenCalledTimes(1)
  })

  it('Edit takes it back into the box, and nothing is sent', async () => {
    const live = await onOpenChat('running')
    type('Rename the helper')
    await send()
    press(q('[data-code-held-edit]')!)
    await flush()
    expect(host.value).toBe('Rename the helper')
    expect(q('[data-code-held]')).toBeNull()
    await turnEnds(live)
    expect(live.send).not.toHaveBeenCalled()
  })

  it('leaving the chat hands it to the server to wait for the turn’s end there: never lost', async () => {
    await onOpenChat('running', [{ method: 'POST', url: MESSAGES, reply: () => json({ messageId: 'm1', requeued: false }) }])
    type('Then update the docs')
    await send()
    act(() => selectCodeChat(null))
    await flush()
    expect(posts().find((c) => c.url === MESSAGES)!.body).toMatchObject({ text: 'Then update the docs', policy: 'queue' })
  })

  it('idle, a message starts its next turn at once, as before', async () => {
    const live = await onOpenChat('waiting')
    type('Now the tests')
    await send()
    expect(live.send).toHaveBeenCalledWith('Now the tests', 'steer', expect.any(String))
    expect(q('[data-code-held]')).toBeNull()
  })
})

/**
 * No Mac, so no toggle (nothing to start a coding chat with). A coding chat
 * that exists still opens as the current chat (a notification, a link:
 * docs/plans/one-home.md, "Every way in"), and the box is that chat's while
 * it is on screen, never the agent's under it.
 */
describe('a coding chat open with no Mac (no toggle)', () => {
  async function open(status: string, over: Record<string, unknown> = {}) {
    await mount({ list: [cloud()], chatEnv: cloud() })
    expect(q('[data-composer-tabs]')).toBeNull()
    const live = { session: session({ id: 'sess-open', status, ...over }), stopping: false, send: vi.fn(async () => ({ ok: true as const })), stop: vi.fn() }
    act(() => {
      openCodingChat('sess-open', { from: 'notification' })
      setCodeChatLive('sess-open', live as never)
    })
    await flush()
    return live
  }

  it('a message goes to that chat, and nothing to the agent or to a new job', async () => {
    const live = await open('waiting')
    type('Now the tests')
    await send()
    expect(live.send).toHaveBeenCalledWith('Now the tests', 'steer', expect.any(String))
    expect(host.value).toBe('')
    expect(posts()).toEqual([])
  })

  it('a chat that ended takes nothing: the words stay in the box, and no job starts', async () => {
    const live = await open('failed')
    type('Try again')
    await send()
    expect(live.send).not.toHaveBeenCalled()
    expect(host.value).toBe('Try again')
    expect(posts()).toEqual([])
  })

  it.each([
    ['stopped', 'cancelled', null],
    ['sat idle a day', 'expired', 'it sat idle for 24 hours'],
  ] as const)('a chat the person %s: the message picks it up again, no new job', async (_name, status, error) => {
    const live = await open(status, { error, attended: true })
    type('Carry on from there')
    await send()
    expect(live.send).toHaveBeenCalledWith('Carry on from there', 'steer', expect.any(String))
    expect(host.value).toBe('')
    expect(posts()).toEqual([])
  })

  it('stopped, but not the person’s own chat (unattended): it takes nothing', async () => {
    const live = await open('cancelled', { error: null, attended: false })
    type('Carry on')
    await send()
    expect(live.send).not.toHaveBeenCalled()
  })

  it('back on the agent, the box is the agent’s again', async () => {
    const live = await open('waiting')
    act(() => backToAgent())
    await flush()
    type('Hello')
    await send()
    expect(live.send).not.toHaveBeenCalled()
  })
})


describe('the model and effort, pinned under the box (721)', () => {
  const TAKING = mac({
    id: 'env-studio',
    name: 'Studio Mac',
    deviceName: 'Studio Mac',
    deviceId: 'dev-studio',
    worker: 'claude-code',
    offeredWorkers: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        takesModel: true,
        models: [
          { id: 'opus', label: 'Opus', efforts: ['low', 'high', 'max'] },
          { id: 'haiku', label: 'Haiku', efforts: [] },
        ],
        efforts: ['low', 'high'],
      },
    ],
    folders: [{ id: 'f-site', label: 'harbor-site', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: 'harbor/site' }],
  })
  const started = (body: unknown) => json({ session: session({ codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201)
  const startBody = () => posts().find((c) => c.url === '/api/local-agent/sessions')!.body as Record<string, unknown>

  it('an app that takes no model: no pickers, and the start names none (the defaults, as before)', async () => {
    await mount({ list: [STUDIO], chatEnv: STUDIO, routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: started }] })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-model-line]')).toBeNull()
    type('Fix the date picker')
    await send()
    expect(startBody()).not.toHaveProperty('model')
    expect(startBody()).not.toHaveProperty('effort')
  })

  it('a new chat: Default and Default, the lists the Mac offers, and the pick goes with the start', async () => {
    await mount({ list: [TAKING], chatEnv: TAKING, routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: started }] })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-model-line="new"]')).not.toBeNull()
    expect(q('[data-code-model-picker="model"]')!.textContent).toBe('Default')
    expect(q('[data-code-model-picker="effort"]')!.textContent).toBe('Default')
    await openMenu('[data-code-model-picker="model"]')
    expect([...document.querySelectorAll('[data-code-model-option]')].map((o) => o.getAttribute('data-code-model-option'))).toEqual(['default', 'opus', 'haiku'])
    press(q('[data-code-model-option="opus"]')!)
    await flush()
    expect(q('[data-code-model-picker="model"]')!.textContent).toBe('Opus')
    await openMenu('[data-code-model-picker="effort"]')
    expect([...document.querySelectorAll('[data-code-model-option]')].map((o) => o.getAttribute('data-code-model-option'))).toEqual(['default', 'low', 'high', 'max'])
    press(q('[data-code-model-option="max"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    expect(startBody()).toMatchObject({ worker: 'claude-code', model: 'opus', effort: 'max' })
  })

  it('remembered per agent on this device; a remembered one the Mac no longer offers is the default again', async () => {
    localStorage.setItem('ni:code:model:claude-code', JSON.stringify({ model: 'haiku', effort: 'high' }))
    await mount({ list: [TAKING], chatEnv: TAKING, routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: started }] })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    // Haiku is offered; it takes no effort, so the effort is its default and no effort picker shows.
    expect(q('[data-code-model-picker="model"]')!.getAttribute('data-code-model-value')).toBe('haiku')
    expect(q('[data-code-model-picker="effort"]')).toBeNull()
    await openMenu('[data-code-model-picker="model"]')
    press(q('[data-code-model-option="opus"]')!)
    await flush()
    expect(JSON.parse(localStorage.getItem('ni:code:model:claude-code')!)).toEqual({ model: 'opus', effort: null })
    // Back to both defaults: forgotten.
    await openMenu('[data-code-model-picker="model"]')
    press(q('[data-code-model-option="default"]')!)
    await flush()
    expect(localStorage.getItem('ni:code:model:claude-code')).toBeNull()
    // One it doesn't offer any more.
    localStorage.setItem('ni:code:model:claude-code', JSON.stringify({ model: 'sonnet', effort: 'high' }))
    act(() => root.unmount())
    root = createRoot(container)
    await mount({ list: [TAKING], chatEnv: TAKING, routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: started }] })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-model-picker="model"]')!.getAttribute('data-code-model-value')).toBe('default')
    expect(q('[data-code-model-picker="effort"]')!.getAttribute('data-code-model-value')).toBe('high')
  })

  it('our own agent: no pickers (it runs on the model its Mac is set to)', async () => {
    await mount({ list: [TAKING], chatEnv: TAKING })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    await openMenu('[data-code-agent-picker]')
    press(q('[data-code-agent-option="native"]')!)
    await flush()
    expect(q('[data-code-model-line]')).toBeNull()
  })

  it('an open chat: read-only, what its agent reports (else what it was started on); no pickers', async () => {
    await mount({ list: [TAKING], chatEnv: TAKING })
    const live = (over: Record<string, unknown>) =>
      ({ session: session({ status: 'waiting', ...over }), stopping: false, send: async () => ({ ok: true }), stop: async () => ({ ok: true }), promptOpen: false, noChanges: false, filesChanged: null, insertions: null, deletions: null }) as never
    act(() => openCodingChat('sess-1'))
    act(() => setCodeChatLive('sess-1', live({ requestedModel: 'opus', requestedEffort: 'max' })))
    await flush()
    expect(q('[data-code-model-line="open"]')!.textContent).toBe('opus · Max')
    expect(q('[data-code-model-picker]')).toBeNull()
    act(() => setCodeChatLive('sess-1', live({ requestedModel: 'opus', model: 'claude-opus-5-5', effort: 'high' })))
    await flush()
    expect(q('[data-code-model-line="open"]')!.textContent).toBe('claude-opus-5-5 · High')
  })
})

describe('an agent whose Mac lists efforts only (Codex today, 721)', () => {
  it('no Model picker (its default model), an Effort picker, and the effort goes with the start', async () => {
    const CODEX_MAC = mac({
      id: 'env-studio',
      name: 'Studio Mac',
      deviceName: 'Studio Mac',
      deviceId: 'dev-studio',
      worker: 'codex',
      offeredWorkers: [{ id: 'codex', label: 'Codex', takesModel: true, models: [], efforts: ['low', 'medium', 'high'] }],
      folders: [{ id: 'f-site', label: 'harbor-site', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: 'harbor/site' }],
    })
    await mount({
      list: [CODEX_MAC],
      chatEnv: CODEX_MAC,
      routes: [{ method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ worker: 'codex', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) }],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    expect(q('[data-code-model-picker="model"]')).toBeNull()
    await openMenu('[data-code-model-picker="effort"]')
    press(q('[data-code-model-option="high"]')!)
    await flush()
    type('Tidy the README')
    await send()
    expect(posts().find((c) => c.url === '/api/local-agent/sessions')!.body).toMatchObject({ worker: 'codex', model: null, effort: 'high' })
  })
})
