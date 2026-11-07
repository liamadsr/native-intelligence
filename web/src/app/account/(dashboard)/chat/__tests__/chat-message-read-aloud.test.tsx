// @vitest-environment jsdom
/**
 * The read-aloud speaker button next to Copy on an assistant reply.
 *
 * Driven end to end through the real useReadAloud (bridge mocked) and the real
 * ReadAloudContext, the way ChatPanel wires it:
 *  - hidden in the browser, when local-tts isn't Ready, and while recording;
 *  - shown otherwise, on assistant replies with text only;
 *  - click → one tts_speak per sentence; while that reply is speaking the
 *    button is Pause (and stays visible without hover); Pause cancels and
 *    keeps the place: the button is Resume, still pinned, and Resume picks up
 *    at the sentence it stopped in; only the most recent pause stays pinned,
 *    an older one says Resume on hover.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { LocalModuleInfo, TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  desktop: true,
  info: null as LocalModuleInfo | null,
  calls: [] as Array<[string, unknown?]>,
  listeners: new Set<(p: TtsStatePayload) => void>(),
}))

vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: vi.fn(),
}))
vi.mock('../../../workspace-switcher', () => ({ useWorkspaceEdition: () => 'full' }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => bridge.desktop }))
vi.mock('@/hooks/use-local-module', () => ({
  useLocalModule: () => ({
    loaded: true,
    supported: bridge.info !== null,
    info: bridge.info,
    state: bridge.info?.state ?? null,
    progress: null,
    enabled: bridge.info?.enabled ?? false,
    busy: false,
    error: null,
    enable: async () => {},
    disable: async () => {},
    removeAssets: async () => {},
  }),
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

import { ChatMessage } from '../chat-message'
import { ReadAloudContext } from '../read-aloud-button'
import { useReadAloud } from '@/hooks/use-read-aloud'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'

const READY: LocalModuleInfo = {
  id: 'local-tts',
  version: 'e801e7d',
  enabled: true,
  state: 'ready',
  progress: null,
  downloadBytes: 144_200_000,
  assetsPresent: true,
  error: null,
}

const reply = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Here is **the plan**. Call Dr. Smith today.', state: 'done' }],
} as unknown as UIMessage
const other = {
  id: 'a3',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Another answer. With two sentences.', state: 'done' }],
} as unknown as UIMessage
const question = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What now?' }] } as unknown as UIMessage
const toolOnly = {
  id: 'a2',
  role: 'assistant',
  parts: [{ type: 'tool-search', toolCallId: 'c1', state: 'input-available', input: {} }],
} as unknown as UIMessage

function Panel({ messages, recording }: { messages: UIMessage[]; recording: boolean }) {
  const readAloud = useReadAloud({ messages, status: 'ready', recording })
  return h(
    ReadAloudContext.Provider,
    { value: readAloud },
    messages.map((m) => h('div', { key: m.id, 'data-msg': m.id }, h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA' }))),
  )
}

let container: HTMLDivElement
let root: Root

async function mount(messages: UIMessage[] = [question, reply], recording = false) {
  await act(async () => root.render(h(Panel, { messages, recording })))
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

const speakerIn = (id: string) =>
  container.querySelector(`[data-msg="${id}"] [data-read-aloud]`) as HTMLButtonElement | null
const speakIds = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { id: string }).id)
const texts = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { text: string }).text)

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  __resetResumePointsForTests()
  bridge.desktop = true
  bridge.info = READY
  bridge.calls = []
  bridge.listeners.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetResumePointsForTests()
})

describe('ChatMessage — read-aloud button', () => {
  it('is shown next to Copy on an assistant reply when read-aloud is supported', async () => {
    await mount()
    const button = speakerIn('a1')
    expect(button).toBeTruthy()
    expect(button!.getAttribute('aria-label')).toBe('Read aloud')
    // Same row as Copy.
    expect(button!.parentElement!.querySelectorAll('button').length).toBe(2)
  })

  it('is never on a user message or an assistant turn with no text', async () => {
    await mount([question, toolOnly, reply])
    expect(speakerIn('u1')).toBeNull()
    expect(speakerIn('a2')).toBeNull()
    expect(speakerIn('a1')).toBeTruthy()
  })

  it('is hidden in the browser', async () => {
    bridge.desktop = false
    bridge.info = null
    await mount()
    expect(speakerIn('a1')).toBeNull()
    expect(container.textContent).toContain('Call Dr. Smith today.')
  })

  it('is hidden when local-tts is not Ready (off, downloading, missing)', async () => {
    for (const info of [{ ...READY, enabled: false, state: 'off' as const }, { ...READY, state: 'downloading' as const }, null]) {
      bridge.info = info
      await mount()
      expect(speakerIn('a1')).toBeNull()
    }
  })

  it('is hidden while a capture is recording', async () => {
    await mount([question, reply], true)
    expect(speakerIn('a1')).toBeNull()
  })

  it('reads the reply; Pause while speaking; Pause cancels and keeps the place; Resume picks up there', async () => {
    await mount()
    expect(speakerIn('a1')!.dataset.readAloud).toBe('idle')
    await act(async () => speakerIn('a1')!.click())
    await settle()
    expect(texts()).toEqual(['Here is the plan.', 'Call Dr. Smith today.'])

    const pauseButton = speakerIn('a1')!
    expect(pauseButton.getAttribute('aria-label')).toBe('Pause')
    expect(pauseButton.dataset.readAloud).toBe('speaking')
    expect(pauseButton.querySelector('svg')?.classList.contains('lucide-pause')).toBe(true)
    // The hover-only actions row is pinned visible while speaking, and paused.
    const row = pauseButton.closest('.opacity-0')!.className
    expect(row).toContain('has-[[data-read-aloud=speaking]]:opacity-100')
    expect(row).toContain('has-[[data-read-aloud=paused]]:opacity-100')

    await act(async () => {
      for (const cb of bridge.listeners) cb({ id: speakIds()[1], state: 'speaking' })
    })
    bridge.calls = []
    await act(async () => pauseButton.click())
    expect(bridge.calls).toEqual([['cancel']])
    expect(getResumePoint('a1')).toBe(1)
    const resumeButton = speakerIn('a1')!
    expect(resumeButton.getAttribute('aria-label')).toBe('Resume')
    expect(resumeButton.dataset.readAloud).toBe('paused')
    expect(resumeButton.querySelector('svg')?.classList.contains('lucide-play')).toBe(true)

    bridge.calls = []
    await act(async () => resumeButton.click())
    await settle()
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(texts()).toEqual(['Call Dr. Smith today.'])
    expect(speakerIn('a1')!.dataset.readAloud).toBe('speaking')
  })

  it('only the most recent pause stays pinned; an older one still says Resume', async () => {
    await mount([question, reply, other])
    await act(async () => speakerIn('a1')!.click())
    await settle()
    // Reading a3 pauses a1; pausing a3 makes it the most recent pause.
    await act(async () => speakerIn('a3')!.click())
    await settle()
    expect(speakerIn('a1')!.dataset.readAloud).toBe('paused')
    await act(async () => speakerIn('a3')!.click())
    expect(speakerIn('a3')!.dataset.readAloud).toBe('paused')
    expect(speakerIn('a1')!.dataset.readAloud).toBe('resumable')
    expect(speakerIn('a1')!.getAttribute('aria-label')).toBe('Resume')
  })

  it('goes back to the speaker once the last sentence is done', async () => {
    await mount()
    await act(async () => speakerIn('a1')!.click())
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    const ids = bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { id: string }).id)
    await act(async () => {
      for (const id of ids) for (const cb of bridge.listeners) cb({ id, state: 'done' })
    })
    expect(speakerIn('a1')!.getAttribute('aria-label')).toBe('Read aloud')
  })
})
