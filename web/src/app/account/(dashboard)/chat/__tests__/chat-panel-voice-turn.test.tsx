// @vitest-environment jsdom
/**
 * A voice-mode turn goes out through ChatPanel's own send path
 * (docs/plans/chat-voice.md §3.4): the spoken text is sent with exactly what
 * a typed turn carries — the panel's context (a call going on rides in it,
 * one-chat Slice 3: never the live meeting's id, never the live agent), and
 * files attached during voice mode — and a reply still generating
 * is stopped first. The words heard preview in the field until the turn goes,
 * and the field is clean (its value never written) afterwards.
 *
 * The real ChatPanel, ChatInput and useVoiceMode; useChat, the voice bridge
 * and voice availability are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, createRef } from 'react'
import type { VoiceEvent } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const hoisted = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'streaming' | 'submitted',
  log: [] as string[],
  sendMessage: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  voice: [] as Array<[string, unknown?]>,
  listeners: new Map<string, (e: VoiceEvent) => void>(),
}))

vi.mock('@ai-sdk/react', async () => {
  const { vi } = await import('vitest')
  hoisted.sendMessage = vi.fn(() => void hoisted.log.push('sendMessage'))
  return {
    useChat: () => ({
      messages: [],
      sendMessage: hoisted.sendMessage,
      setMessages: vi.fn(),
      addToolResult: vi.fn(),
      status: hoisted.status,
      stop: async () => void hoisted.log.push('stop'),
      error: undefined,
      regenerate: vi.fn(),
    }),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
  Toaster: () => null,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => {
      const ch: Record<string, unknown> = {}
      ch.on = () => ch
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: () => {},
  }),
}))

vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))
// The composer's glow (voice mode lights it like a capture): no canvas in jsdom.
vi.mock('voice-glow', () => ({ VoiceBeam: () => null }))
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({ flushTranscriptForAgent: async () => {}, getSegmentsForAgent: () => [] }),
}))
vi.mock('../slash-command-picker', () => ({ useRecipeCommands: () => [], SlashCommandPicker: () => null }))
vi.mock('@/lib/chat/upload-client', () => ({
  ChatUploadError: class extends Error {},
  uploadChatFile: async (file: File) => ({
    fileId: 'file-1',
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    fileExtension: 'md',
    storagePath: 'u/file-1.md',
    url: 'https://files.test/file-1.md',
  }),
}))

// Desktop voice, both modules ready, the mic free.
vi.mock('@/hooks/use-voice-availability', () => ({
  useVoiceAvailability: () => ({
    visible: true,
    dictation: true,
    conversation: true,
    blocked: null,
    status: { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' },
  }),
  voiceBlockedLabel: () => 'blocked',
}))

vi.mock('@/lib/tauri-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-bridge')>()
  return {
    ...actual,
    tauriBridge: {
      ...actual.tauriBridge,
      voiceStart: async (args: unknown) => void hoisted.voice.push(['start', args]),
      voiceStop: async (id: string) => void hoisted.voice.push(['stop', id]),
      voiceCancel: async (id: string) => void hoisted.voice.push(['cancel', id]),
      ttsPrepare: async () => {},
      ttsCancel: async () => {},
      onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
        hoisted.listeners.set(id, cb)
        return () => hoisted.listeners.delete(id)
      },
    },
  }
})

import { ChatPanel, type ChatPanelHandle } from '../chat-panel'
import { voiceBirdState } from '@/components/birds/voice-bird'

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).split('?')[0] === '/api/account/chat-history/conv-1') {
        return {
          ok: true,
          json: async () => ({ messages: [], title: 'Pricing sync' }),
        } as Response
      }
      if (url === '/api/account/agents/rec-interactive') {
        return {
          ok: true,
          json: async () => ({
            agent: {
              id: 'rec-interactive',
              name: 'Interactive Assistant',
              icon: null,
              color: null,
              description: null,
              agent_config: { enabled_tools: ['actions'] },
            },
          }),
        } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }),
  )
}

describe('a voice-mode turn goes out through the panel send path', () => {
  let container: HTMLDivElement
  let root: Root
  let ref: React.RefObject<ChatPanelHandle | null>

  function panel() {
    return h(ChatPanel, {
      ref,
      chatSessionId: 'sess-1',
      userAvatarUrl: null,
      userInitials: 'LA',
      alwaysShowMessages: true,
      // What the host sends while a call is on (main-chat-host.tsx).
      systemContext: { onCallCaptureId: 'cap-1' },
    })
  }

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
  }

  async function mountOnCall() {
    ref = createRef<ChatPanelHandle>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(panel()))
    await settle()
  }

  async function startVoiceMode() {
    const waveform = container.querySelector('button[aria-label="Start voice mode"]') as HTMLButtonElement
    expect(waveform).not.toBeNull()
    await act(async () => waveform.click())
    await settle()
    expect(hoisted.voice[0]).toEqual(['start', expect.objectContaining({ mode: 'conversation' })])
    expect(voiceModeOn()).toBe(true)
  }

  /** Voice mode's end (the stop square) holds send's slot. */
  function voiceModeOn() {
    return container.querySelector('button[aria-label="End voice mode"]') !== null
  }

  async function speak(text: string) {
    const [id] = [...hoisted.listeners.keys()]
    await act(async () => hoisted.listeners.get(id)!({ type: 'turn', turnId: 't1', text }))
    await settle()
  }

  beforeEach(() => {
    hoisted.status = 'ready'
    hoisted.log = []
    hoisted.voice = []
    hoisted.listeners.clear()
    hoisted.sendMessage?.mockClear()
    installFetch()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('sends the spoken text with the panel context: the call line, never the live meeting or its agent', async () => {
    await mountOnCall()
    await startVoiceMode()
    await speak('Send Maya the pricing deck')

    expect(hoisted.sendMessage).toHaveBeenCalledTimes(1)
    const [message, { body }] = hoisted.sendMessage.mock.calls[0] as [{ text: string }, { body: Record<string, any> }]
    expect(message).toEqual({ text: 'Send Maya the pricing deck', metadata: { createdAt: expect.any(String) } })
    expect(body.agentId).toBeUndefined()
    expect(body.systemContext.onCallCaptureId).toBe('cap-1')
    expect(body.systemContext.liveCaptureId).toBeUndefined()
    // Said in voice mode: the agent is told its reply is read aloud.
    expect(body.systemContext.voiceMode).toBe(true)
    // No stop: nothing was generating.
    expect(hoisted.log).toEqual(['sendMessage'])
  })

  it('stops a reply still generating before the spoken turn is sent', async () => {
    await mountOnCall()
    await startVoiceMode()
    hoisted.status = 'streaming'
    await act(async () => root.render(panel()))
    await settle()
    // Still in voice mode while the reply streams.
    expect(voiceModeOn()).toBe(true)

    await speak('Actually, make it Friday')
    // The spoken turn waits for the stopped reply to settle (never sent over
    // its stream, which would duplicate it), then goes.
    expect(hoisted.log).toEqual(['stop'])
    hoisted.status = 'ready'
    await act(async () => root.render(panel()))
    await settle()
    expect(hoisted.log).toEqual(['stop', 'sendMessage'])
    const [, { body }] = hoisted.sendMessage.mock.calls[0] as [unknown, { body: Record<string, any> }]
    expect(body.systemContext.onCallCaptureId).toBe('cap-1')
    expect(body.agentId).toBeUndefined()
  })

  it('a file attached during voice mode goes out with the spoken turn', async () => {
    await mountOnCall()
    await startVoiceMode()
    // The + menu's file picker still works during voice mode.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const notes = new File(['Renewal terms'], 'renewal.md', { type: 'text/markdown' })
    Object.defineProperty(input, 'files', { value: [notes], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()

    await speak('Summarize this')
    expect(hoisted.sendMessage).toHaveBeenCalledTimes(1)
    const [message, { body }] = hoisted.sendMessage.mock.calls[0] as [
      { text: string; files?: Array<{ filename: string; url: string }> },
      { body: Record<string, any> },
    ]
    expect(message.text).toBe('Summarize this')
    expect(message.files).toEqual([
      expect.objectContaining({ filename: 'renewal.md', url: 'https://files.test/file-1.md' }),
    ])
    expect(body.systemContext.chatFiles).toEqual([expect.objectContaining({ fileName: 'renewal.md' })])
    // Sent, so it leaves the composer.
    expect(container.textContent).not.toContain('renewal.md')
  })

  it('loading another conversation ends voice mode', async () => {
    await mountOnCall()
    await startVoiceMode()
    const [id] = [...hoisted.listeners.keys()]
    await act(async () => ref.current!.loadConversation('conv-1'))
    await settle()
    expect(hoisted.voice.at(-1)).toEqual(['stop', id])
    expect(voiceModeOn()).toBe(false)
  })

  it('the words heard preview in the field, then the field is clean for the next turn', async () => {
    await mountOnCall()
    await startVoiceMode()
    const [id] = [...hoisted.listeners.keys()]
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.readOnly).toBe(true)

    // The model comes up (voice mode goes live), then the user talks.
    await act(async () => hoisted.listeners.get(id)!({ type: 'state', state: 'listening', echo: 'cancelling' }))
    await settle()
    await act(async () => hoisted.listeners.get(id)!({ type: 'state', state: 'user_speaking', echo: 'cancelling' }))
    await act(async () => hoisted.listeners.get(id)!({ type: 'transcript', turnId: 't1', text: 'Send Maya', final: false }))
    await settle()
    expect(container.querySelector('[data-dictation-tail]')?.textContent).toBe('Send Maya')
    expect(textarea.value).toBe('')

    await speak('Send Maya the deck')
    expect(hoisted.sendMessage).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-dictation-tail]')).toBeNull()
    expect(textarea.value).toBe('')
  })
  it('the handle starts and ends voice mode from outside (the voice bird), and reports it', async () => {
    await mountOnCall()
    expect(voiceBirdState().voiceActive).toBe(false)
    let refusal: unknown = 'pending'
    await act(async () => {
      refusal = await ref.current!.startVoiceMode()
    })
    await settle()
    expect(refusal).toBeNull()
    expect(hoisted.voice[0]).toEqual(['start', expect.objectContaining({ mode: 'conversation' })])
    expect(voiceModeOn()).toBe(true)
    expect(voiceBirdState()).toMatchObject({ voiceActive: true })
    // Already on: started, nothing new.
    await act(async () => {
      refusal = await ref.current!.startVoiceMode()
    })
    expect(refusal).toBeNull()
    expect(hoisted.voice.filter(([k]) => k === 'start')).toHaveLength(1)

    const [id] = [...hoisted.listeners.keys()]
    await act(async () => ref.current!.endVoiceMode())
    await settle()
    expect(hoisted.voice.at(-1)).toEqual(['stop', id])
    expect(voiceModeOn()).toBe(false)
    expect(voiceBirdState()).toMatchObject({ voiceActive: false, phase: null })
  })
})
