// @vitest-environment jsdom
/**
 * useReadAloud — ChatPanel's read-aloud brain, with the desktop bridge mocked.
 *
 * Contract pinned here:
 *  - supported = desktop + local-tts enabled & Ready + not recording; otherwise
 *    nothing touches the bridge.
 *  - speakMessage sends one tts_speak per sentence, in order, ids
 *    `${messageId}:${pageLoadId}:${n}`, after clearing the desktop queue;
 *    speakingMessageId clears when the last sentence is done, or on
 *    cancelled / error. A `text_too_long` refusal skips just that sentence.
 *  - Auto-read (setting on) follows a reply that starts streaming while the
 *    panel is mounted: tts_prepare at turn start, each finished sentence as it
 *    arrives, the rest when status settles. Never history, never a restored or
 *    resumed-on-mount stream.
 *  - Cancels on stop(), a new turn, the message leaving the chat, a recording
 *    starting, a Voice ID enrollment recording, pagehide, and unmount.
 *  - pause() cancels and keeps the sentence speaking (@/lib/read-aloud/
 *    resume-points); speakMessage() of that message resumes there: a finished
 *    reply from that sentence, a streaming one past what was spoken, following
 *    the stream on. Reading another message, or another reader taking the
 *    desktop, pauses too. stop() and interrupt() (voice mode), a new turn and
 *    a reply read to its end keep no place; nor does a spoken line, or a run
 *    that never said anything.
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
  speakImpl: null as null | ((args: { id: string; text: string; voice?: string }) => Promise<void>),
  listeners: new Set<(p: TtsStatePayload) => void>(),
}))

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
    ttsSpeak: async (args: { id: string; text: string; voice?: string }) => {
      bridge.calls.push(['speak', args])
      if (bridge.speakImpl) await bridge.speakImpl(args)
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

import { useReadAloud, type ReadAloudHandle, type UseReadAloudOptions } from '../use-read-aloud'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'
import { __resetResumePointsForTests, getLastPausedKey, getResumePoint } from '@/lib/read-aloud/resume-points'
import { claimReader, releaseReader } from '@/lib/read-aloud/reader'
import { messageSpeechMarkdown } from '@/lib/read-aloud/message-text'

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

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage
const assistant = (id: string, text: string, state?: 'streaming' | 'done') =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text, ...(state ? { state } : {}) }] }) as unknown as UIMessage

// ── Harness ─────────────────────────────────────────────────────────────────

type Props = UseReadAloudOptions
let root: Root
let host: HTMLDivElement
let handle: ReadAloudHandle
let props: Props

function Harness(p: Props) {
  handle = useReadAloud(p)
  return null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function render(next: Partial<Props>) {
  props = { ...props, ...next }
  await act(async () => {
    root.render(h(Harness, props))
  })
  await flush()
}

async function emit(p: TtsStatePayload) {
  await act(async () => {
    for (const cb of [...bridge.listeners]) cb(p)
  })
  await flush()
}

const speaks = () =>
  bridge.calls.filter((c) => c[0] === 'speak').map((c) => c[1] as { id: string; text: string; voice?: string })
const spokenTexts = () => speaks().map((s) => s.text)
const count = (kind: string) => bridge.calls.filter((c) => c[0] === kind).length

beforeEach(() => {
  __resetResumePointsForTests()
  bridge.desktop = true
  bridge.info = READY
  bridge.calls = []
  bridge.speakImpl = null
  bridge.listeners.clear()
  localStorage.clear()
  props = { messages: [], status: 'ready', recording: false }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

// ── supported ───────────────────────────────────────────────────────────────

describe('useReadAloud — supported', () => {
  it('is supported on a desktop with local-tts enabled and Ready', async () => {
    await render({})
    expect(handle.supported).toBe(true)
  })

  it('is not supported in the browser, and never touches the bridge', async () => {
    bridge.desktop = false
    bridge.info = null
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: [user('u1', 'Hi')], status: 'ready' })
    expect(handle.supported).toBe(false)
    handle.speakMessage('a1', 'Hello. World.')
    await render({ messages: [user('u1', 'Hi'), user('u2', 'Again')], status: 'submitted' })
    await render({ messages: [user('u1', 'Hi'), user('u2', 'Again'), assistant('a2', 'One. Two. Three')], status: 'streaming' })
    await render({ status: 'ready' })
    expect(bridge.calls).toEqual([])
    expect(bridge.listeners.size).toBe(0)
  })

  it('is not supported when the module is off, downloading or not in this build', async () => {
    for (const info of [
      { ...READY, enabled: false, state: 'off' as const },
      { ...READY, state: 'downloading' as const },
      { ...READY, state: 'unavailable' as const },
      null,
    ]) {
      bridge.info = info
      await render({})
      expect(handle.supported).toBe(false)
    }
  })

  it('is not supported while recording', async () => {
    await render({ recording: true })
    expect(handle.supported).toBe(false)
    handle.speakMessage('a1', 'Hello.')
    await flush()
    expect(speaks()).toEqual([])
  })
})

// ── speakMessage ────────────────────────────────────────────────────────────

describe('useReadAloud — speakMessage', () => {
  const md = '## Result\n\nDr. Smith closed the deal. It was worth $4.2M!\n\n```js\nnope()\n```\n\n- Next step'

  it('clears the queue, then sends each sentence in order with ids `${messageId}:${pageLoadId}:${n}`', async () => {
    await render({ messages: [assistant('a1', md)] })
    await act(async () => handle.speakMessage('a1', md))
    await flush()

    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(spokenTexts()).toEqual(['Result.', 'Dr. Smith closed the deal.', 'It was worth $4.2M!', 'Next step.'])
    const ids = speaks().map((s) => s.id)
    for (const id of ids) expect(id).toMatch(/^a1:[a-z0-9]+:\d+$/)
    expect(new Set(ids.map((id) => id.split(':')[1])).size).toBe(1)
    expect(new Set(ids).size).toBe(ids.length)
    const ns = ids.map((id) => Number(id.split(':')[2]))
    expect([...ns].sort((a, b) => a - b)).toEqual(ns)
    expect(speaks()[0].voice).toBeUndefined()
    expect(handle.speakingMessageId).toBe('a1')
  })

  it('passes the chosen voice', async () => {
    localStorage.setItem('dial8:read-aloud:voice', 'marius')
    await render({ messages: [assistant('a1', 'Hi there.')] })
    await act(async () => handle.speakMessage('a1', 'Hi there.'))
    await flush()
    expect(speaks()).toEqual([expect.objectContaining({ text: 'Hi there.', voice: 'marius' })])
  })

  it('stays speaking until the LAST sentence is done', async () => {
    await render({ messages: [assistant('a1', 'One. Two. Three.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    const [s1, s2, s3] = speaks()
    await emit({ id: s1.id, state: 'speaking' })
    await emit({ id: s1.id, state: 'done' })
    await emit({ id: s2.id, state: 'done' })
    expect(handle.speakingMessageId).toBe('a1')
    await emit({ id: s3.id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
  })

  it('clears on cancelled, and on error (cancelling the rest)', async () => {
    await render({ messages: [assistant('a1', 'One. Two.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two.'))
    await flush()
    await emit({ id: speaks()[0].id, state: 'cancelled' })
    expect(handle.speakingMessageId).toBeNull()

    bridge.calls = []
    await act(async () => handle.speakMessage('a1', 'One. Two.'))
    await flush()
    await emit({ id: speaks()[0].id, state: 'error', error: 'device lost' })
    expect(handle.speakingMessageId).toBeNull()
    expect(bridge.calls.at(-1)).toEqual(['cancel'])
  })

  it('ignores state events for ids it did not send', async () => {
    await render({ messages: [assistant('a1', 'One.')] })
    await act(async () => handle.speakMessage('a1', 'One.'))
    await flush()
    await emit({ id: 'other:1', state: 'cancelled' })
    await emit({ id: 'a1:999999', state: 'done' })
    expect(handle.speakingMessageId).toBe('a1')
  })

  it('ignores events for the same message from a previous page load (ids restart there)', async () => {
    await render({ messages: [assistant('a1', 'One. Two.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two.'))
    await flush()
    for (let n = 0; n < 3; n++) await emit({ id: `a1:${n}`, state: 'cancelled' })
    expect(handle.speakingMessageId).toBe('a1')
    expect(bridge.calls.map((c) => c[0])).toEqual(['cancel', 'speak', 'speak'])
  })

  it('a sentence refused as text_too_long is skipped; the run reads on', async () => {
    bridge.speakImpl = async ({ text }) => {
      if (text === 'Two.') throw Object.assign(new Error('text_too_long'), { code: 'text_too_long' })
    }
    await render({ messages: [assistant('a1', 'One. Two. Three.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    expect(spokenTexts()).toEqual(['One.', 'Two.', 'Three.'])
    expect(bridge.calls.filter((c) => c[0] === 'cancel')).toHaveLength(1) // only the leading one
    expect(handle.speakingMessageId).toBe('a1')
    await emit({ id: speaks()[0].id, state: 'done' })
    expect(handle.speakingMessageId).toBe('a1')
    await emit({ id: speaks()[2].id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
  })

  it('a text_too_long last sentence still lets the run finish', async () => {
    bridge.speakImpl = async ({ text }) => {
      if (text === 'Two.') throw Object.assign(new Error('text_too_long'), { code: 'text_too_long' })
    }
    await render({ messages: [assistant('a1', 'One. Two.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two.'))
    await flush()
    await emit({ id: speaks()[0].id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
  })

  it('a sentence the desktop reports as text_too_long (after spelling out numbers) is skipped too', async () => {
    await render({ messages: [assistant('a1', 'One. Two. Three.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    const [s1, s2, s3] = speaks()
    bridge.calls = []
    await emit({ id: s1.id, state: 'done' })
    await emit({ id: s2.id, state: 'error', error: 'text_too_long' })
    expect(handle.speakingMessageId).toBe('a1')
    expect(bridge.calls).toEqual([])
    await emit({ id: s3.id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
    expect(bridge.calls).toEqual([])
  })

  it('a refused speak (e.g. recording) ends the run', async () => {
    bridge.speakImpl = async () => {
      throw new Error('recording')
    }
    await render({ messages: [assistant('a1', 'One. Two. Three.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    expect(speaks()).toHaveLength(1) // the rest are dropped
    expect(handle.speakingMessageId).toBeNull()
  })

  it('stop() cancels now and clears', async () => {
    await render({ messages: [assistant('a1', 'One. Two.')] })
    await act(async () => handle.speakMessage('a1', 'One. Two.'))
    await flush()
    bridge.calls = []
    await act(async () => handle.stop())
    await flush()
    expect(bridge.calls).toEqual([['cancel']])
    expect(handle.speakingMessageId).toBeNull()
  })

  it('speaking another message replaces the first', async () => {
    await render({ messages: [assistant('a1', 'One.'), assistant('a2', 'Two.')] })
    await act(async () => handle.speakMessage('a1', 'One.'))
    await flush()
    await act(async () => handle.speakMessage('a2', 'Two.'))
    await flush()
    expect(handle.speakingMessageId).toBe('a2')
    // a1's late cancelled event no longer matters.
    await emit({ id: speaks()[0].id, state: 'cancelled' })
    expect(handle.speakingMessageId).toBe('a2')
    expect(bridge.calls.map((c) => c[0])).toEqual(['cancel', 'speak', 'cancel', 'speak'])
  })
})

// ── auto-read ───────────────────────────────────────────────────────────────

describe('useReadAloud — auto-read', () => {
  const history = [user('u1', 'Earlier question'), assistant('a1', 'An earlier answer. With two sentences.')]

  async function streamReply(chunks: string[], id = 'a2') {
    await render({ messages: [...history, user('u2', 'New question')], status: 'submitted' })
    for (const text of chunks) {
      await render({ messages: [...history, user('u2', 'New question'), assistant(id, text, 'streaming')], status: 'streaming' })
    }
  }

  it('prepares the engine, speaks each sentence as it finishes, and flushes at the end', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    expect(bridge.calls).toEqual([])

    await render({ messages: [...history, user('u2', 'New question')], status: 'submitted' })
    expect(count('prepare')).toBe(1)

    const base = [...history, user('u2', 'New question')]
    await render({ messages: [...base, assistant('a2', 'Sure. Here')], status: 'streaming' })
    expect(spokenTexts()).toEqual(['Sure.'])
    expect(handle.speakingMessageId).toBe('a2')

    await render({ messages: [...base, assistant('a2', 'Sure. Here is the plan for Dr. Smith. First')], status: 'streaming' })
    expect(spokenTexts()).toEqual(['Sure.', 'Here is the plan for Dr. Smith.'])

    await render({ messages: [...base, assistant('a2', 'Sure. Here is the plan for Dr. Smith. First, call him', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['Sure.', 'Here is the plan for Dr. Smith.', 'First, call him'])
    for (const s of speaks()) expect(s.id).toMatch(/^a2:[a-z0-9]+:\d+$/)

    // A cancel clears the queue before the first sentence; none after.
    const kinds = bridge.calls.map((c) => c[0])
    expect(kinds.indexOf('cancel')).toBeLessThan(kinds.indexOf('speak'))
    expect(kinds.lastIndexOf('cancel')).toBeLessThan(kinds.indexOf('speak'))

    for (const s of speaks()) await emit({ id: s.id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
  })

  it('never reads code, even streamed', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    await streamReply(['Run this:\n\n```sh\necho "Hi. There."\n', 'Run this:\n\n```sh\necho "Hi. There."\n```\n\nDone. Bye'])
    await render({ status: 'ready' })
    expect(spokenTexts()).toEqual(['Run this:', 'Done.', 'Bye'])
  })

  it('a reply that starts streaming while read-aloud is held (dictation) is not spoken', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    await render({ messages: [...history, user('u2', 'New question')], status: 'submitted' })
    // Dictation starts while the reply is still 'submitted'.
    let release = () => {}
    await act(async () => {
      release = holdReadAloud()
    })
    await flush()
    await streamReply(['Sure. Here is', 'Sure. Here is the plan. Next'])
    expect(speaks()).toEqual([])
    expect(handle.speakingMessageId).toBeNull()
    await act(async () => release())
  })

  it('does nothing when auto-read is off', async () => {
    await render({ messages: history, status: 'ready' })
    await streamReply(['One. Two', 'One. Two. Three'])
    await render({ status: 'ready' })
    expect(bridge.calls).toEqual([])
  })

  it('does not start in a hidden panel', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready', active: false })
    await streamReply(['One. Two', 'One. Two. Three'])
    await render({ status: 'ready' })
    expect(bridge.calls).toEqual([])
  })

  it('never reads history: restored messages, a loaded conversation, or a stream already running at mount', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    // Restored history at mount.
    await render({ messages: history, status: 'ready' })
    // A conversation loaded into the panel.
    await render({ messages: [user('x1', 'Old'), assistant('x2', 'Old answer. Really old.')], status: 'ready' })
    expect(bridge.calls).toEqual([])

    // A panel that mounts mid-stream (resumed) doesn't pick that turn up.
    await act(async () => root.unmount())
    root = createRoot(host)
    props = { messages: [user('u1', 'Q'), assistant('a9', 'Half. Way')], status: 'streaming', recording: false }
    await render({})
    await render({ messages: [user('u1', 'Q'), assistant('a9', 'Half. Way there. Done')] })
    await render({ status: 'ready' })
    expect(speaks()).toEqual([])
  })

  it('reads only what a resumed turn adds to an existing reply', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    const asking = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Which account? ', state: 'done' },
        { type: 'tool-ask_user', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
      ],
    } as unknown as UIMessage
    await render({ messages: [user('u1', 'Q'), asking], status: 'ready' })
    await render({ status: 'streaming' })
    const resumed = { ...asking, parts: [...asking.parts, { type: 'text', text: 'Acme it is. Opening it now.', state: 'done' }] } as unknown as UIMessage
    await render({ messages: [user('u1', 'Q'), resumed] })
    await render({ status: 'ready' })
    expect(spokenTexts()).toEqual(['Acme it is.', 'Opening it now.'])
  })

  it('tapping the speaker on the streaming reply follows it to the end', async () => {
    await render({ messages: history, status: 'ready' })
    await streamReply(['First sentence. Second'])
    expect(bridge.calls).toEqual([]) // auto-read is off
    await act(async () => handle.speakMessage('a2', 'First sentence. Second'))
    await flush()
    expect(handle.speakingMessageId).toBe('a2')
    expect(spokenTexts()).toEqual(['First sentence.'])
    await render({ messages: [...history, user('u2', 'New question'), assistant('a2', 'First sentence. Second one. Third', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['First sentence.', 'Second one.', 'Third'])
  })
})

// ── cancel triggers ─────────────────────────────────────────────────────────

describe('useReadAloud — cancels', () => {
  const history = [user('u1', 'Q'), assistant('a1', 'Answer one. Answer two.')]

  async function speakA1() {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'Answer one. Answer two.'))
    await flush()
    expect(handle.speakingMessageId).toBe('a1')
    bridge.calls = []
  }

  it('on a new turn (sending a message)', async () => {
    await speakA1()
    await render({ messages: [...history, user('u2', 'Next')], status: 'submitted' })
    expect(bridge.calls).toEqual([['cancel']])
    expect(handle.speakingMessageId).toBeNull()
  })

  it('on Stop mid-auto-read: nothing more is sent for that reply', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    await render({ messages: [...history, user('u2', 'Next')], status: 'submitted' })
    await render({ messages: [...history, user('u2', 'Next'), assistant('a2', 'One. Two')], status: 'streaming' })
    expect(spokenTexts()).toEqual(['One.'])
    await act(async () => handle.stop())
    await flush()
    expect(bridge.calls.at(-1)).toEqual(['cancel'])
    await render({ messages: [...history, user('u2', 'Next'), assistant('a2', 'One. Two. Three. Four')], status: 'streaming' })
    await render({ status: 'ready' })
    expect(spokenTexts()).toEqual(['One.'])
  })

  it('on Stop before the first sentence finished: the stopped reply is not read at the end', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    await render({ messages: [...history, user('u2', 'Next')], status: 'submitted' })
    await act(async () => handle.stop())
    await render({ messages: [...history, user('u2', 'Next'), assistant('a2', 'Half a sente')], status: 'ready' })
    expect(speaks()).toEqual([])
  })

  it('when a recording starts', async () => {
    await speakA1()
    await render({ recording: true })
    expect(bridge.calls).toEqual([['cancel']])
    expect(handle.speakingMessageId).toBeNull()
    expect(handle.supported).toBe(false)
  })

  it('when the module stops being Ready', async () => {
    await speakA1()
    bridge.info = { ...READY, enabled: false, state: 'off' }
    await render({})
    expect(bridge.calls).toEqual([['cancel']])
    expect(handle.speakingMessageId).toBeNull()
  })

  it('when the message leaves the chat (New chat / load conversation)', async () => {
    await speakA1()
    await render({ messages: [user('x1', 'Other'), assistant('x2', 'Other answer.')] })
    expect(bridge.calls).toEqual([['cancel']])
    expect(handle.speakingMessageId).toBeNull()
  })

  it('when a Voice ID enrollment starts recording (and not again until it ends)', async () => {
    await speakA1()
    let release!: () => void
    await act(async () => {
      release = holdReadAloud()
    })
    await flush()
    expect(bridge.calls.map((c) => c[0])).toContain('cancel')
    expect(handle.speakingMessageId).toBeNull()
    expect(handle.supported).toBe(false)
    bridge.calls = []
    handle.speakMessage('a1', 'Answer one. Answer two.')
    await flush()
    expect(speaks()).toEqual([])
    await act(async () => release())
    expect(handle.supported).toBe(true)
  })

  it('on pagehide (reload, hard navigation, window closed) while reading', async () => {
    await speakA1()
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(bridge.calls).toEqual([['cancel']])
  })

  it('not on pagehide when nothing is being read', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(bridge.calls).toEqual([])
  })

  it('someone else’s cancel ends the run without cancelling their read', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'Answer one. Answer two.'))
    await flush()
    const [s1, s2] = speaks()
    bridge.calls = []
    await emit({ id: s1.id, state: 'cancelled' })
    await emit({ id: s2.id, state: 'cancelled' })
    expect(handle.speakingMessageId).toBeNull()
    await emit({ id: 'preview:x', state: 'queued' })
    expect(bridge.calls).toEqual([])
  })

  it('a sentence of ours that survived someone else’s cancel is silenced', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'Answer one. Answer two.'))
    await flush()
    const [s1, s2] = speaks()
    await emit({ id: s1.id, state: 'queued' })
    bridge.calls = []
    // The other party's cancel hit s1; s2 was queued after it.
    await emit({ id: s1.id, state: 'cancelled' })
    expect(handle.speakingMessageId).toBeNull()
    expect(bridge.calls).toEqual([])
    await emit({ id: s2.id, state: 'queued' })
    // Not yet: a speak accepted just before that cancel reports `queued`,
    // then its own `cancelled`. Anything else next means s2 survived.
    expect(bridge.calls).toEqual([])
    await emit({ id: 'preview:x', state: 'speaking' })
    expect(bridge.calls).toEqual([['cancel']])
  })

  it('a sentence accepted just before someone else’s cancel (queued, then cancelled) is left alone', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'Answer one. Answer two. Answer three.'))
    await flush()
    const [s1, s2, s3] = speaks()
    await emit({ id: s1.id, state: 'queued' })
    bridge.calls = []
    await emit({ id: s1.id, state: 'cancelled' })
    // The desktop's order for a speak whose text was still being normalized.
    await emit({ id: s2.id, state: 'queued' })
    await emit({ id: s2.id, state: 'cancelled' })
    await emit({ id: s3.id, state: 'queued' })
    await emit({ id: s3.id, state: 'cancelled' })
    await emit({ id: 'preview:x', state: 'queued' })
    await emit({ id: 'preview:x', state: 'speaking' })
    expect(bridge.calls).toEqual([])
  })

  it('a sentence of ours that starts speaking after someone else’s cancel is silenced at once', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'Answer one. Answer two.'))
    await flush()
    const [s1, s2] = speaks()
    bridge.calls = []
    await emit({ id: s1.id, state: 'cancelled' })
    await emit({ id: s2.id, state: 'speaking' })
    expect(bridge.calls).toEqual([['cancel']])
  })

  it('on unmount', async () => {
    await speakA1()
    await act(async () => root.unmount())
    await flush()
    expect(bridge.calls).toEqual([['cancel']])
    root = createRoot(host) // for afterEach
  })

  it('when another panel starts reading, this one lets go', async () => {
    await speakA1()
    const host2 = document.createElement('div')
    const root2 = createRoot(host2)
    let other!: ReadAloudHandle
    function Other(p: Props) {
      other = useReadAloud(p)
      return null
    }
    await act(async () => root2.render(h(Other, { messages: [assistant('b1', 'Other panel.')], status: 'ready', recording: false })))
    await act(async () => other.speakMessage('b1', 'Other panel.'))
    await flush()
    expect(other.speakingMessageId).toBe('b1')
    expect(handle.speakingMessageId).toBeNull()
    await act(async () => root2.unmount())
  })
})

// ── pause and resume (@/lib/read-aloud/resume-points) ──────────────────────

describe('useReadAloud — pause and resume', () => {
  const history = [user('u1', 'Q'), assistant('a1', 'One. Two. Three.')]
  /** The calls in order: 'cancel', 'prepare', or a spoken sentence's text. */
  const said = () => bridge.calls.map((c) => (c[0] === 'speak' ? (c[1] as { text: string }).text : c[0]))

  async function speakA1() {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
  }

  it('pause cancels and keeps the sentence speaking; speakMessage resumes there after a leading cancel', async () => {
    await speakA1()
    const [s1, s2] = speaks()
    await emit({ id: s1.id, state: 'done' })
    await emit({ id: s2.id, state: 'speaking' })
    bridge.calls = []
    await act(async () => handle.pause())
    await flush()
    expect(bridge.calls).toEqual([['cancel']])
    expect(handle.speakingMessageId).toBeNull()
    expect(getResumePoint('a1')).toBe(1)
    expect(getLastPausedKey()).toBe('a1')

    bridge.calls = []
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    expect(said()).toEqual(['cancel', 'Two.', 'Three.'])
    expect(handle.speakingMessageId).toBe('a1')
    expect(getResumePoint('a1')).toBeNull() // the run carries its place now
  })

  it('a reply read to its end keeps no place: the next tap starts from the top', async () => {
    await speakA1()
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => handle.pause())
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    for (const s of speaks()) await emit({ id: s.id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
    expect(getResumePoint('a1')).toBeNull()
    bridge.calls = []
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    expect(spokenTexts()).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('pause with nothing playing does nothing', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.pause())
    expect(bridge.calls).toEqual([])
    expect(getLastPausedKey()).toBeNull()
  })

  it('reading another message pauses the first, which keeps its place', async () => {
    await render({ messages: [...history, assistant('a2', 'Other. Answer.')], status: 'ready' })
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    await emit({ id: speaks()[2].id, state: 'speaking' })
    await act(async () => handle.speakMessage('a2', 'Other. Answer.'))
    await flush()
    expect(handle.speakingMessageId).toBe('a2')
    expect(getResumePoint('a1')).toBe(2)
  })

  it('another reader taking the desktop pauses the reply; a run that never said anything keeps no place', async () => {
    await speakA1()
    const section = {}
    await act(async () => claimReader(section, () => {}))
    expect(handle.speakingMessageId).toBeNull()
    expect(getResumePoint('a1')).toBe(0)
    releaseReader(section)

    // Auto-read following a reply with no finished sentence yet.
    __resetResumePointsForTests()
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: [...history, user('u2', 'Next')], status: 'submitted' })
    await render({ messages: [...history, user('u2', 'Next'), assistant('a2', 'Half a sente', 'streaming')], status: 'streaming' })
    await act(async () => claimReader(section, () => {}))
    expect(getResumePoint('a2')).toBeNull()
    expect(getLastPausedKey()).toBeNull()
    releaseReader(section)
  })

  it('paused while it streams: not followed again on its own; resumed, it skips what was spoken and follows the stream on', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    const base = [...history, user('u2', 'Next')]
    await render({ messages: base, status: 'submitted' })
    await render({ messages: [...base, assistant('a2', 'Alpha. Beta. Gam', 'streaming')], status: 'streaming' })
    expect(spokenTexts()).toEqual(['Alpha.', 'Beta.'])
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => handle.pause())
    await flush()
    expect(getResumePoint('a2')).toBe(1)

    // The turn is not followed again: the stream grows, nothing is read.
    await render({ messages: [...base, assistant('a2', 'Alpha. Beta. Gamma. Delta', 'streaming')], status: 'streaming' })
    expect(spokenTexts()).toEqual(['Alpha.', 'Beta.'])

    // The button while it still streams: Beta again, Gamma, then the rest as it comes.
    bridge.calls = []
    await act(async () => handle.speakMessage('a2', 'Alpha. Beta. Gamma. Delta'))
    await flush()
    expect(said()).toEqual(['cancel', 'Beta.', 'Gamma.'])
    await render({ messages: [...base, assistant('a2', 'Alpha. Beta. Gamma. Delta. Done.', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['Beta.', 'Gamma.', 'Delta.', 'Done.'])
  })

  it('paused while it streams and resumed once finished: the finished reply from that sentence', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    await render({ messages: history, status: 'ready' })
    const base = [...history, user('u2', 'Next')]
    await render({ messages: base, status: 'submitted' })
    await render({ messages: [...base, assistant('a2', 'Alpha. Beta. Gam', 'streaming')], status: 'streaming' })
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => handle.pause())
    const done = assistant('a2', 'Alpha. Beta. Gamma. Delta.', 'done')
    await render({ messages: [...base, done], status: 'ready' })
    bridge.calls = []
    await act(async () => handle.speakMessage('a2', messageSpeechMarkdown(done)))
    await flush()
    expect(said()).toEqual(['cancel', 'Beta.', 'Gamma.', 'Delta.'])
  })

  it('a resumed turn reads only what it adds, but its place counts the whole reply', async () => {
    localStorage.setItem('dial8:read-aloud:auto', '1')
    const asking = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Which account? ', state: 'done' },
        { type: 'tool-ask_user', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
      ],
    } as unknown as UIMessage
    const withText = (text: string, state: 'streaming' | 'done') =>
      ({ ...asking, parts: [...asking.parts, { type: 'text', text, state }] }) as unknown as UIMessage
    await render({ messages: [user('u1', 'Q'), asking], status: 'ready' })
    await render({ status: 'streaming' })
    await render({ messages: [user('u1', 'Q'), withText('Acme it is. Opening it now. Then', 'streaming')] })
    expect(spokenTexts()).toEqual(['Acme it is.', 'Opening it now.'])
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => handle.pause())
    // "Opening it now." is the whole reply's third sentence.
    expect(getResumePoint('a1')).toBe(2)

    const finished = withText('Acme it is. Opening it now. Then done.', 'done')
    await render({ messages: [user('u1', 'Q'), finished], status: 'ready' })
    bridge.calls = []
    await act(async () => handle.speakMessage('a1', messageSpeechMarkdown(finished)))
    await flush()
    expect(spokenTexts()).toEqual(['Opening it now.', 'Then done.'])
  })

  it('stop() and interrupt() (voice mode) keep no place; nor does a new turn', async () => {
    await speakA1()
    await emit({ id: speaks()[1].id, state: 'speaking' })
    await act(async () => handle.stop())
    expect(getResumePoint('a1')).toBeNull()

    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    await emit({ id: speaks().at(-1)!.id, state: 'speaking' })
    await act(async () => handle.interrupt())
    expect(getResumePoint('a1')).toBeNull()

    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    await render({ messages: [...history, user('u2', 'Next')], status: 'submitted' })
    expect(handle.speakingMessageId).toBeNull()
    expect(getResumePoint('a1')).toBeNull()
    expect(getLastPausedKey()).toBeNull()
  })

  it('a spoken line (voice mode’s greeting) keeps no place when another read takes over', async () => {
    await render({ messages: history, status: 'ready' })
    let id: string | null = null
    await act(async () => {
      id = handle.speakLine('Hey there. What is up?')
    })
    await flush()
    await act(async () => handle.speakMessage('a1', 'One. Two. Three.'))
    await flush()
    expect(handle.speakingMessageId).toBe('a1')
    expect(getResumePoint(id!)).toBeNull()
    expect(getLastPausedKey()).toBeNull()
  })
})

// ── voice mode (docs/plans/chat-voice.md §3.4) ──────────────────────────────

describe('useReadAloud — voice mode', () => {
  const history = [user('u1', 'Q'), assistant('a1', 'Answer one. Answer two.')]

  it('followNextTurn: the next turn is read aloud with auto-read off', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.followNextTurn())
    await render({ messages: [...history, user('u2', 'Spoken turn')], status: 'submitted' })
    expect(count('prepare')).toBe(1)
    await render({ messages: [...history, user('u2', 'Spoken turn'), assistant('a2', 'Sure. On it', 'streaming')], status: 'streaming' })
    await render({ messages: [...history, user('u2', 'Spoken turn'), assistant('a2', 'Sure. On it now.', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['Sure.', 'On it now.'])

    // Only that turn: the next typed one follows the setting (off) again.
    bridge.calls = []
    const after = [...history, user('u2', 'Spoken turn'), assistant('a2', 'Sure. On it now.', 'done')]
    await render({ messages: [...after, user('u3', 'Typed')], status: 'submitted' })
    await render({ messages: [...after, user('u3', 'Typed'), assistant('a3', 'Typed reply. Here.', 'done')], status: 'ready' })
    expect(speaks()).toEqual([])
  })

  it('followNextTurn after stopping a reply mid-stream: the stop and the new send can land in one render', async () => {
    await render({ messages: history, status: 'ready' })
    const base = [...history, user('u2', 'First')]
    await render({ messages: [...base, assistant('a2', 'Long answer. Still going', 'streaming')], status: 'streaming' })
    // Voice mode stopped a2 and sent u3: status never settles in between.
    await act(async () => handle.followNextTurn())
    const next = [...base, assistant('a2', 'Long answer. Still going', 'done'), user('u3', 'Actually, wait')]
    await render({ messages: next, status: 'submitted' })
    await render({ messages: [...next, assistant('a3', 'Okay. Waiting.', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['Okay.', 'Waiting.'])
  })

  it('followNextTurn does nothing where read-aloud is not supported', async () => {
    bridge.info = null
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.followNextTurn())
    await render({ messages: [...history, user('u2', 'Spoken')], status: 'submitted' })
    await render({ messages: [...history, user('u2', 'Spoken'), assistant('a2', 'Reply. Here.', 'done')], status: 'ready' })
    expect(bridge.calls).toEqual([])
  })

  it('interrupt: queued sentences are dropped, the rest of the reply is not read, and no cancel of its own', async () => {
    // Speaks never resolve, so later sentences stay queued behind the first.
    let releaseFirst!: () => void
    bridge.speakImpl = () => new Promise<void>((resolve) => (releaseFirst = resolve))
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.followNextTurn())
    const base = [...history, user('u2', 'Spoken')]
    await render({ messages: base, status: 'submitted' })
    await render({ messages: [...base, assistant('a2', 'One. Two. Three. Four', 'streaming')], status: 'streaming' })
    expect(spokenTexts()).toEqual(['One.'])
    expect(handle.speakingMessageId).toBe('a2')
    const cancelsBefore = count('cancel')

    // Barge-in: the desktop already cancelled the audio.
    await act(async () => handle.interrupt())
    await flush()
    expect(handle.speakingMessageId).toBeNull()
    // The speak in flight could land after the desktop's cancel: one chained
    // cancel follows it, and nothing else is spoken.
    await act(async () => releaseFirst())
    await flush()
    expect(spokenTexts()).toEqual(['One.'])
    expect(count('cancel')).toBe(cancelsBefore + 1)

    // The reply keeps streaming as text; none of it is read.
    await render({ messages: [...base, assistant('a2', 'One. Two. Three. Four. Five.', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['One.'])
  })

  it('interrupt with nothing in flight sends no cancel at all', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => handle.followNextTurn())
    const base = [...history, user('u2', 'Spoken')]
    await render({ messages: base, status: 'submitted' })
    await render({ messages: [...base, assistant('a2', 'One. Two', 'streaming')], status: 'streaming' })
    const cancelsBefore = count('cancel')
    await act(async () => handle.interrupt())
    await flush()
    expect(count('cancel')).toBe(cancelsBefore)
    expect(handle.speakingMessageId).toBeNull()
  })
})

// ── speakLine: voice mode's greeting ────────────────────────────────────────

describe('useReadAloud — speakLine (a line that is no chat message)', () => {
  const history = [user('u1', 'Q'), assistant('a1', 'Answer one.')]

  it('speaks under an id no message has, and plays to its end whatever the messages do', async () => {
    await render({ messages: history, status: 'ready' })
    let id: string | null = null
    await act(async () => {
      id = handle.speakLine("What's up?")
    })
    await flush()
    expect(id).toMatch(/^line:/)
    expect(history.some((m) => m.id === id)).toBe(false)
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(spokenTexts()).toEqual(["What's up?"])
    expect(speaks()[0].id.startsWith(`${id}:`)).toBe(true)
    expect(handle.speakingMessageId).toBe(id)
    // The chat changing (a new chat, retention) doesn't end it: it was never in it.
    const cancels = count('cancel')
    await render({ messages: [user('x1', 'Other chat')], status: 'ready' })
    expect(handle.speakingMessageId).toBe(id)
    expect(count('cancel')).toBe(cancels)
    await emit({ id: speaks()[0].id, state: 'done' })
    expect(handle.speakingMessageId).toBeNull()
  })

  it('is no turn: the next voice turn is still followed, and a typed one still follows the setting', async () => {
    await render({ messages: history, status: 'ready' })
    await act(async () => void handle.speakLine('Hey'))
    await flush()
    await emit({ id: speaks()[0].id, state: 'done' })
    bridge.calls = []
    // A typed turn: auto-read is off, the line didn't force it on.
    await render({ messages: [...history, user('u2', 'Typed')], status: 'submitted' })
    const typed = [...history, user('u2', 'Typed'), assistant('a2', 'Typed reply.', 'done')]
    await render({ messages: typed, status: 'ready' })
    expect(speaks()).toEqual([])
    // A spoken turn: followed as ever.
    await act(async () => handle.followNextTurn())
    await render({ messages: [...typed, user('u3', 'Spoken')], status: 'submitted' })
    await render({ messages: [...typed, user('u3', 'Spoken'), assistant('a3', 'Sure. Done.', 'done')], status: 'ready' })
    expect(spokenTexts()).toEqual(['Sure.', 'Done.'])
  })

  it('stop() or a new turn ends it like any run', async () => {
    let release!: () => void
    bridge.speakImpl = () => new Promise<void>((resolve) => (release = resolve))
    await render({ messages: history, status: 'ready' })
    await act(async () => void handle.speakLine('Yo'))
    await flush()
    expect(handle.speakingMessageId).toMatch(/^line:/)
    await act(async () => handle.stop())
    await flush()
    expect(handle.speakingMessageId).toBeNull()
    release()
    await flush()

    bridge.speakImpl = null
    await act(async () => void handle.speakLine('Yo'))
    await flush()
    await render({ messages: [...history, user('u2', 'Talking over it')], status: 'submitted' })
    expect(handle.speakingMessageId).toBeNull()
  })

  it('speaks nothing where read-aloud is not supported', async () => {
    bridge.info = null
    await render({ messages: history, status: 'ready' })
    let id: string | null = 'unset'
    await act(async () => {
      id = handle.speakLine('Hey')
    })
    expect(id).toBeNull()
    expect(bridge.calls).toEqual([])
  })
})

// ── A voice of its own (a bot's, bots-v2.md Phase 4) ────────────────────────

describe('useReadAloud — its own voice', () => {
  it('speaks a message, a line and a followed reply in `voice`, over the Read aloud setting', async () => {
    localStorage.setItem('dial8:read-aloud:voice', 'marius')
    await render({ voice: 'lori', messages: [user('u1', 'Hi')], status: 'ready' })
    await act(async () => handle.speakMessage('m1', 'One.'))
    await flush()
    await act(async () => void handle.speakLine('Two.'))
    await flush()
    await act(async () => handle.followNextTurn())
    await render({ messages: [user('u1', 'Hi'), user('u2', 'Spoken')], status: 'submitted' })
    await render({ messages: [user('u1', 'Hi'), user('u2', 'Spoken'), assistant('a2', 'Three.', 'done')], status: 'ready' })
    expect(speaks().map((s) => [s.text, s.voice])).toEqual([
      ['One.', 'lori'],
      ['Two.', 'lori'],
      ['Three.', 'lori'],
    ])
  })

  it('falls back to the Read aloud setting without one', async () => {
    localStorage.setItem('dial8:read-aloud:voice', 'marius')
    await render({ voice: null })
    await act(async () => void handle.speakLine('Hey.'))
    await flush()
    expect(speaks()).toEqual([expect.objectContaining({ text: 'Hey.', voice: 'marius' })])
  })

  it('speaks a line given as sentences one per call, as given, skipping blanks', async () => {
    await render({ voice: 'lori' })
    let id: string | null = null
    await act(async () => {
      id = handle.speakLine(['The draft to Alex, about Q3.', '  ', 'Hi Alex,', 'Thursday works.'])
    })
    await flush()
    expect(id).toMatch(/^line:/)
    expect(spokenTexts()).toEqual(['The draft to Alex, about Q3.', 'Hi Alex,', 'Thursday works.'])
  })
})
