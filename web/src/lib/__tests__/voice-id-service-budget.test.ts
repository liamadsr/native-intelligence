import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * VoiceIdService's cost budget during a capture (src/lib/voice-id-service.ts):
 *   - one embedding hears at most MAX_EMBED_SECONDS, the segment's middle
 *     (WavLM's memory grows with the square of the clip and onnxruntime's
 *     WASM heap never shrinks: a 60 s segment held the page at 2.2 GB);
 *   - after each embedding the worker rests EMBED_REST_FACTOR × its time
 *     before taking the next segment (at most a third of one core).
 *
 * Driven through a cast onto a fake worker, as the other service tests do:
 * there is no Web Worker or model in vitest.
 */

import { VoiceIdService, MAX_EMBED_SECONDS, EMBED_REST_FACTOR } from '@/lib/voice-id-service'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

const SAMPLE_RATE = 16000

interface Internals {
  worker: { postMessage: ReturnType<typeof vi.fn> } | null
  modelLoaded: boolean
  pendingCallbacks: Map<string, (response: unknown) => void>
}

function internals(svc: VoiceIdService): Internals {
  return svc as unknown as Internals
}

/** A service with a fake loaded worker and `seconds` of mic audio, each second's samples = its index. */
function serviceWithAudio(seconds: number) {
  const svc = new VoiceIdService()
  const postMessage = vi.fn()
  internals(svc).worker = { postMessage }
  internals(svc).modelLoaded = true
  const pcm = new Uint8Array(seconds * SAMPLE_RATE * 2)
  const view = new DataView(pcm.buffer)
  for (let i = 0; i < seconds * SAMPLE_RATE; i++) view.setInt16(i * 2, Math.floor(i / SAMPLE_RATE), true)
  svc.feedAudio('mic', pcm)
  return { svc, postMessage }
}

function segment(startTime: number, endTime: number): TranscriptSegment {
  return { id: `s-${startTime}`, speaker: 'local_1', stream: 'mic', isFinal: true, startTime, endTime, text: 'hello', words: [] } as unknown as TranscriptSegment
}

/** The second (index) a posted clip starts at, read back from the sample values. */
const secondOf = (sample: number) => Math.round(sample * 32768)

function sent(postMessage: ReturnType<typeof vi.fn>, call: number) {
  return postMessage.mock.calls[call][0] as { id: string; audio: Float32Array }
}

let now = 0
afterEach(() => {
  vi.restoreAllMocks()
})

describe('VoiceIdService embedding budget', () => {
  it('embeds only the middle MAX_EMBED_SECONDS of a long segment', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    now = 1000
    const { svc, postMessage } = serviceWithAudio(40)

    svc.onFinalSegment(segment(0, 30))

    expect(postMessage).toHaveBeenCalledTimes(1)
    const { audio } = sent(postMessage, 0)
    expect(audio.length).toBe(MAX_EMBED_SECONDS * SAMPLE_RATE)
    // 30 s segment, 8 s clip: from 11 s to 19 s.
    expect(secondOf(audio[0])).toBe((30 - MAX_EMBED_SECONDS) / 2)
    expect(secondOf(audio[audio.length - 1])).toBe((30 + MAX_EMBED_SECONDS) / 2 - 1)
  })

  it('embeds a short segment whole', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    now = 1000
    const { svc, postMessage } = serviceWithAudio(10)

    svc.onFinalSegment(segment(2, 7))

    const { audio } = sent(postMessage, 0)
    expect(audio.length).toBe(5 * SAMPLE_RATE)
    expect(secondOf(audio[0])).toBe(2)
  })

  it('rests EMBED_REST_FACTOR × the embedding time before the next segment', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    now = 1000
    const { svc, postMessage } = serviceWithAudio(40)

    svc.onFinalSegment(segment(0, 5))
    expect(postMessage).toHaveBeenCalledTimes(1)

    // The worker answers 3 s later.
    now = 4000
    const { id } = sent(postMessage, 0)
    internals(svc).pendingCallbacks.get(id)!({ type: 'embedding', id, embedding: new Array(512).fill(0.01) })

    // Still resting: 3 s of work → 6 s of rest, until 10 s.
    now = 4000 + 3000 * EMBED_REST_FACTOR - 1
    svc.onFinalSegment(segment(5, 10))
    expect(postMessage).toHaveBeenCalledTimes(1)

    now = 4000 + 3000 * EMBED_REST_FACTOR
    svc.onFinalSegment(segment(10, 15))
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('rests after a worker error too', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    now = 1000
    const { svc, postMessage } = serviceWithAudio(40)

    svc.onFinalSegment(segment(0, 5))
    now = 2000
    const { id } = sent(postMessage, 0)
    internals(svc).pendingCallbacks.get(id)!({ type: 'error', id, error: 'boom' })

    now = 2000 + 1000 * EMBED_REST_FACTOR - 1
    svc.onFinalSegment(segment(5, 10))
    expect(postMessage).toHaveBeenCalledTimes(1)

    now = 2000 + 1000 * EMBED_REST_FACTOR
    svc.onFinalSegment(segment(10, 15))
    expect(postMessage).toHaveBeenCalledTimes(2)
  })
})
