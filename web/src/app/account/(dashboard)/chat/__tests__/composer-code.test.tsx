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
 *     words, the picked agent, the folder), puts the person's message in the
 *     thread, clears the box, keeps the choice for the conversation, and the
 *     job draws inline after that message;
 *   - a refusal keeps the words and says why; a cloud environment says the
 *     cloud comes next and sends nothing;
 *   - while the job works, Stop stops it; a later send goes to it;
 *   - a conversation with a Code job opens on Code with that job's agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'

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
// The job's own view (LocalAgentPanel) has its tests; here, where it draws.
vi.mock('../code-job-block', () => ({ CodeJobBlock: ({ sessionId }: { sessionId: string }) => h('div', { 'data-code-job': sessionId }) }))

import { ChatInput } from '../chat-input'
import { ChatMessageList } from '../chat-message-list'
import { useComposerEnvironment, useComposerFolders } from '../composer-state'
import { useComposerCode } from '../composer-code'
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
  trackedJobId: null, createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', endedAt: null, lastDeviceSeq: null, startedBy: 'person',
  worker: 'claude-code', codeRequestId: 'req-x', ...over,
})

const host = { messages: [] as UIMessage[], value: '' }

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
    conversationIdNow: async () => CONV,
    chatBusy: () => false,
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
    h(ChatInput, {
      value,
      onChange: setValue,
      onSubmit: () => {
        if (code.active) void code.submit(value).then((sent) => sent && setValue(''))
      },
      onStop: () => {},
      isLoading: false,
      attachedNotes: [],
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
    expect(q('[data-composer-tabs]')!.getAttribute('role')).toBe('radiogroup')
    expect(q('[data-code-agent-picker]')).toBeNull()
    expect(q('[data-worker-toggle]')).toBeNull()
    expect(q('[data-code-folder-picker]')).toBeNull()
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
    expect(q('[data-code-agent-connect-hint]')!.textContent).toContain('On Studio Mac: Install it and sign in on that Mac, then allow it from the Native Intelligence menu bar icon')
  })

  it('a send starts the job with the person’s words, puts their message in the thread, clears the box, keeps the choice, and draws the job after it', async () => {
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
    expect(host.messages[0]).toMatchObject({ id: `code-${requestId}`, role: 'user', metadata: { local_agent_code: { requestId } } })
    expect(host.value).toBe('')
    expect(JSON.parse(localStorage.getItem(`${CODE_TAB_STORAGE_PREFIX}${CONV}`)!)).toEqual({ tab: 'code', agent: 'claude-code', folderId: 'f-site' })
    // The job, inline, right after the message that started it.
    const row = q(`[data-message-row="code-${requestId}"]`)!
    expect((row.nextElementSibling as HTMLElement).getAttribute('data-code-job')).toBe('sess-1')
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
    type('Fix it')
    expect((q('button[aria-label^="Send"]') as HTMLButtonElement).disabled).toBe(true)
    expect(posts()).toEqual([])
  })

  it('while the job works, Stop stops it; a later send goes to the job as its next message', async () => {
    let n = 0
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      routes: [
        { method: 'POST', url: '/api/local-agent/sessions/sess-1/stop', reply: () => json({ session: session({ status: 'cancelled' }) }) },
        { method: 'POST', url: '/api/local-agent/sessions/sess-1/messages', reply: () => json({ messageId: `m-${++n}`, requeued: false }) },
        { method: 'POST', url: '/api/local-agent/sessions', reply: (body) => json({ session: session({ status: 'running', codeRequestId: (body as { requestId: string }).requestId }), created: true, joined: false, deviceOnline: true }, 201) },
      ],
    })
    press(q('[data-composer-tab="code"]')!)
    await flush()
    type('Fix the date picker')
    await send()
    // Working: with nothing typed, the slot is Stop, for the agent.
    const stopButton = q('button[aria-label="Stop Claude Code"]')!
    expect(stopButton).not.toBeNull()
    type('And add a test for it')
    await send()
    const message = posts().find((c) => c.url === '/api/local-agent/sessions/sess-1/messages')!
    expect(message.body).toMatchObject({ text: 'And add a test for it', policy: 'queue' })
    expect(host.messages[1]).toMatchObject({ role: 'user', metadata: { local_agent_code: { sessionId: 'sess-1' } } })
    // That message is in the job's own view: it takes no row of its own.
    expect(q(`[data-message-row="${host.messages[1].id}"]`)).toBeNull()
    press(q('button[aria-label="Stop Claude Code"]')!)
    await flush()
    expect(posts().some((c) => c.url === '/api/local-agent/sessions/sess-1/stop')).toBe(true)
    expect(q('button[aria-label="Stop Claude Code"]')).toBeNull()
  })

  it('a conversation with a Code job opens on Code with that job’s agent, and draws it after its message', async () => {
    const started: UIMessage = { id: 'code-req-1', role: 'user', parts: [{ type: 'text', text: 'Fix it' }], metadata: { local_agent_code: { requestId: 'req-1' } } }
    await mount({
      list: [STUDIO],
      chatEnv: STUDIO,
      initial: [started],
      routes: [{ url: `/api/local-agent/sessions?conversationId=${CONV}`, reply: () => json({ sessions: [session({ worker: null, codeRequestId: 'req-1', status: 'waiting' })] }) }],
    })
    expect(q('[data-composer-tab="code"]')!.getAttribute('data-state')).toBe('on')
    expect(q('[data-code-agent-picker]')!.getAttribute('data-code-agent-picker')).toBe('native')
    expect(q('[data-code-job="sess-1"]')).not.toBeNull()
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
