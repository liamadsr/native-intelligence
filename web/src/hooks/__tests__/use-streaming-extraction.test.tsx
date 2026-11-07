// @vitest-environment jsdom
/**
 * useStreamingExtraction coalesces streamed tokens: every token lands in
 * `streamingTextRef` at once (the typewriter reads that per frame), while the
 * `streamingText` STATE catches up at most once per animation frame — a
 * setState per token re-rendered the whole capture panel for each one. Done,
 * a closed stream, and errors flush synchronously, so the state (and onDone's
 * fallback text) is complete; unmount / a new start drop a scheduled flush.
 *
 * Rendered standalone with createRoot/act (no @testing-library in this repo);
 * fetch returns a hand-driven SSE body and rAF is a manual frame queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}))

import { useStreamingExtraction, type ExtractionDonePayload } from '../use-streaming-extraction'

type Chunk = { done: boolean; value?: Uint8Array }

/** An SSE response body whose chunks the test pushes one read at a time. */
function sseBody() {
  const waiting: Array<(c: Chunk) => void> = []
  const queued: Chunk[] = []
  const deliver = (c: Chunk) => {
    const w = waiting.shift()
    if (w) w(c)
    else queued.push(c)
  }
  const encoder = new TextEncoder()
  return {
    body: {
      getReader: () => ({
        read: () =>
          queued.length ? Promise.resolve(queued.shift()!) : new Promise<Chunk>((r) => waiting.push(r)),
      }),
    },
    push(...events: object[]) {
      deliver({
        done: false,
        value: encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')),
      })
    },
    close() {
      deliver({ done: true })
    },
  }
}

// Manual animation frames.
let frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
function runFrame() {
  const due = [...frames.values()]
  frames = new Map()
  act(() => {
    for (const cb of due) cb(performance.now())
  })
}

async function flushAsync() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

let container: HTMLDivElement
let root: Root
let hook: ReturnType<typeof useStreamingExtraction>
let renders = 0
const onDone = vi.fn<(p: ExtractionDonePayload) => void>()
const onError = vi.fn<(m: string) => void>()

function Probe() {
  hook = useStreamingExtraction({ onDone, onError })
  renders++
  return null
}

async function startStream() {
  const sse = sseBody()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sse.body,
      headers: { get: () => 'text/event-stream' },
    })),
  )
  await act(async () => {
    void hook.start({ captureId: 'cap-1', mode: 'batch' })
  })
  await flushAsync()
  return sse
}

beforeEach(async () => {
  frames = new Map()
  nextFrameId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  renders = 0
  onDone.mockClear()
  onError.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(h(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useStreamingExtraction — token coalescing', () => {
  it('tokens reach the ref at once; the state catches up once per frame', async () => {
    const sse = await startStream()
    expect(hook.isStreaming).toBe(true)

    const before = renders
    sse.push({ type: 'text', text: 'The team ' }, { type: 'text', text: 'agreed ' })
    await flushAsync()
    sse.push({ type: 'text', text: 'to ship.' })
    await flushAsync()

    expect(hook.streamingTextRef.current).toBe('The team agreed to ship.')
    expect(hook.streamingText).toBe('') // no frame yet
    expect(frames.size).toBe(1) // one flush scheduled for three tokens
    expect(renders).toBe(before)

    runFrame()
    expect(hook.streamingText).toBe('The team agreed to ship.')
    expect(renders).toBe(before + 1)

    // Nothing new → no flush scheduled, no render.
    runFrame()
    expect(renders).toBe(before + 1)
  })

  it('done flushes the text synchronously before onDone', async () => {
    const sse = await startStream()
    const payload = { ok: true, text: 'canonical', tool_calls: 1, auto_applied: 0 }
    sse.push({ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }, { type: 'done', payload })
    await flushAsync()

    expect(onDone).toHaveBeenCalledWith(payload)
    expect(hook.isStreaming).toBe(false)
    expect(hook.streamingText).toBe('Hello world')
    expect(frames.size).toBe(0) // the scheduled flush was folded into done
  })

  it('a stream that closes without done reports the complete text', async () => {
    const sse = await startStream()
    sse.push({ type: 'text', text: 'Partial ' }, { type: 'text', text: 'preview' })
    await flushAsync()
    sse.close()
    await flushAsync()

    expect(onDone).toHaveBeenCalledWith({ ok: true, text: 'Partial preview', tool_calls: 0, auto_applied: 0 })
    expect(hook.streamingText).toBe('Partial preview')
    expect(frames.size).toBe(0)
  })

  it('an error event flushes the text before onError', async () => {
    const sse = await startStream()
    sse.push({ type: 'text', text: 'Half a sum' }, { type: 'error', error: 'boom' })
    await flushAsync()

    expect(onError).toHaveBeenCalledWith('boom')
    expect(hook.streamingText).toBe('Half a sum')
    expect(frames.size).toBe(0)
  })

  it('a new start resets the text and drops the previous run’s scheduled flush', async () => {
    const first = await startStream()
    first.push({ type: 'text', text: 'old run' })
    await flushAsync()
    expect(frames.size).toBe(1)

    const second = await startStream()
    expect(frames.size).toBe(0)
    expect(hook.streamingTextRef.current).toBe('')
    expect(hook.streamingText).toBe('')

    second.push({ type: 'text', text: 'new run' })
    await flushAsync()
    runFrame()
    expect(hook.streamingText).toBe('new run')
  })

  it('unmount cancels a scheduled flush', async () => {
    const sse = await startStream()
    sse.push({ type: 'text', text: 'tail' })
    await flushAsync()
    expect(frames.size).toBe(1)

    act(() => root.unmount())
    expect(frames.size).toBe(0)
    root = createRoot(container) // for afterEach
  })
})
