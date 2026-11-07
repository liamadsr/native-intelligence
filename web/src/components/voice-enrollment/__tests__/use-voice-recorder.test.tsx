// @vitest-environment jsdom
/**
 * Enrollment recorder hook — the frozen-noise-floor contract.
 *
 * The noise floor MUST be snapshotted once during the pre-speech mic-check
 * window and then frozen: the chunker's floor lookup at passage-end calls
 * `measureNoiseFloor()` again, and if that re-measured over the (now
 * speech-laden) level samples the voiced threshold would inflate and otherwise
 * good takes would fail. We drive `WebAudioCapture`'s `onLevel`/`onPcm`
 * callbacks directly (fully mocked — no getUserMedia) and assert:
 *   • the floor is the mean of PRE-SPEECH level samples only;
 *   • re-calling measureNoiseFloor after speech returns the SAME frozen value;
 *   • beginPassage resets the level-sample buffer (no stale floor re-read);
 *   • a fresh `start()` unfreezes so a re-open re-measures.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useImperativeHandle, forwardRef } from 'react'
import type { VoiceRecorder } from '../use-voice-recorder'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Controllable WebAudioCapture mock ──────────────────────────
// A single live instance whose onLevel/onPcm we fire by hand.
const cap = vi.hoisted(() => ({
  instance: null as null | {
    onLevel: ((lvl: number) => void) | null
    onPcm: ((bytes: Uint8Array) => void) | null
    isRunning: boolean
  },
  fireLevel(lvl: number) {
    cap.instance?.onLevel?.(lvl)
  },
  firePcm(bytes: Uint8Array) {
    cap.instance?.onPcm?.(bytes)
  },
}))

vi.mock('@/lib/web-audio-capture', () => {
  class WebAudioCapture {
    onLevel: ((lvl: number) => void) | null = null
    onPcm: ((bytes: Uint8Array) => void) | null = null
    isRunning = false
    deviceId: string | undefined = undefined
    async start(opts: { deviceId?: string } = {}) {
      this.isRunning = true
      // What getUserMedia picked: the requested device, else the OS default.
      this.deviceId = opts.deviceId ?? 'os-default'
      cap.instance = this
    }
    stop() {
      this.isRunning = false
      this.deviceId = undefined
    }
  }
  class WebAudioCaptureError extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.kind = kind
    }
  }
  return { WebAudioCapture, WebAudioCaptureError }
})

import { useVoiceRecorder } from '../use-voice-recorder'

// Harness: surface the hook's return through a ref so the test can call it.
const Harness = forwardRef<VoiceRecorder>(function Harness(_props, ref) {
  const rec = useVoiceRecorder()
  useImperativeHandle(ref, () => rec, [rec])
  return null
})

let container: HTMLDivElement
let root: Root

/** Int16-LE bytes for a Float32 sample array (inverse of int16BytesToFloat32). */
function pcmBytes(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, Math.round(samples[i] * 32768), true)
  }
  return new Uint8Array(buf)
}

beforeEach(() => {
  cap.instance = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

function mountRecorder(): { current: VoiceRecorder } {
  const ref: { current: VoiceRecorder | null } = { current: null }
  act(() => root.render(h(Harness, { ref })))
  return ref as { current: VoiceRecorder }
}

describe('useVoiceRecorder — frozen noise floor', () => {
  it('snapshots the floor from pre-speech samples and freezes it against later speech', async () => {
    const ref = mountRecorder()

    await act(async () => {
      await ref.current.start()
    })

    // Pre-speech ambient window: several quiet level samples (~0.005).
    act(() => {
      for (let i = 0; i < 8; i++) cap.fireLevel(0.005)
    })

    // Freeze the floor at mic-check completion.
    let floor = 0
    act(() => {
      floor = ref.current.measureNoiseFloor()
    })
    expect(floor).toBeCloseTo(0.005, 3)

    // Now LOUD speech-level samples arrive. Re-measuring naively would average
    // these in and massively inflate the floor.
    act(() => {
      for (let i = 0; i < 20; i++) cap.fireLevel(0.2)
    })

    let refloor = 0
    act(() => {
      refloor = ref.current.measureNoiseFloor()
    })
    // Frozen: identical to the pre-speech snapshot, NOT inflated toward 0.2.
    expect(refloor).toBe(floor)
    expect(refloor).toBeCloseTo(0.005, 3)
  })

  it('freezes even when the chunker re-reads the floor after a full passage of speech', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    act(() => {
      for (let i = 0; i < 8; i++) cap.fireLevel(0.006)
    })
    let floor = 0
    act(() => {
      floor = ref.current.measureNoiseFloor()
    })

    // Begin a passage and stream loud PCM speech through onPcm (which also
    // fires onLevel-equivalent RMS accrual). beginPassage must clear the
    // level-sample buffer, and the floor must stay frozen.
    act(() => ref.current.beginPassage())
    act(() => {
      for (let i = 0; i < 10; i++) {
        cap.fireLevel(0.25)
        cap.firePcm(pcmBytes(new Array(1600).fill(0.25)))
      }
    })

    // The chunker's passage-end floor lookup.
    let passageFloor = 0
    act(() => {
      passageFloor = ref.current.measureNoiseFloor()
    })
    expect(passageFloor).toBe(floor)
    expect(passageFloor).toBeLessThan(0.02)
  })

  it('unfreezes on a fresh start() so a re-open re-measures the ambient floor', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    act(() => {
      for (let i = 0; i < 8; i++) cap.fireLevel(0.004)
    })
    act(() => {
      ref.current.measureNoiseFloor()
    })

    // Re-open: the frozen flag resets; a new (slightly louder but still
    // sub-speech) ambient room is measured afresh (0.012 < the speech floor).
    act(() => ref.current.stop())
    await act(async () => {
      await ref.current.start()
    })
    act(() => {
      for (let i = 0; i < 8; i++) cap.fireLevel(0.012)
    })
    let floor2 = 0
    act(() => {
      floor2 = ref.current.measureNoiseFloor()
    })
    expect(floor2).toBeCloseTo(0.012, 3)
  })

  it('excludes the first speech sample (and after) from the pre-speech floor', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    // Pre-speech ambient window.
    act(() => {
      for (let i = 0; i < 8; i++) cap.fireLevel(0.005)
    })
    // A loud speech-level sample arrives BEFORE we snapshot — it must NOT be
    // averaged into the floor (speech-detection stops feeding the buffer).
    act(() => {
      cap.fireLevel(0.3)
      cap.fireLevel(0.3)
    })
    expect(ref.current.speechDetected).toBe(true)

    let floor = 0
    act(() => {
      floor = ref.current.measureNoiseFloor()
    })
    // Still the pre-speech mean (~0.005), not pulled up by the 0.3 samples.
    expect(floor).toBeCloseTo(0.005, 3)
  })

  it('resets the voiced-seconds tally to 0 synchronously on beginPassage', () => {
    const ref = mountRecorder()
    act(() => ref.current.beginPassage())
    expect(ref.current.passageVoicedSeconds).toBe(0)
  })
})

describe('useVoiceRecorder — incremental snapshot surface', () => {
  it('publishes the growing sample count on a coarse cadence, not every block', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    act(() => ref.current.beginPassage())
    expect(ref.current.passageSampleCount).toBe(0)

    // Ten 1600-sample blocks = 16000 samples = exactly one publish interval.
    // The count stays 0 until the interval is crossed, then jumps once.
    act(() => {
      for (let i = 0; i < 9; i++) cap.firePcm(pcmBytes(new Array(1600).fill(0.2)))
    })
    expect(ref.current.passageSampleCount).toBe(0) // 14400 < 16000 → not yet
    act(() => cap.firePcm(pcmBytes(new Array(1600).fill(0.2))))
    expect(ref.current.passageSampleCount).toBe(16000) // crossed → published once
  })

  it('snapshotPassageAudio returns accumulated audio WITHOUT stopping accumulation', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    act(() => ref.current.beginPassage())
    act(() => {
      for (let i = 0; i < 5; i++) cap.firePcm(pcmBytes(new Array(1600).fill(0.2)))
    })

    let snap: Float32Array = new Float32Array(0)
    act(() => {
      snap = ref.current.snapshotPassageAudio()
    })
    expect(snap.length).toBe(5 * 1600)

    // Accumulation is STILL live — more PCM extends the buffer, and a second
    // snapshot is longer (the first snapshot never consumed/cleared anything).
    act(() => {
      for (let i = 0; i < 3; i++) cap.firePcm(pcmBytes(new Array(1600).fill(0.2)))
    })
    let snap2: Float32Array = new Float32Array(0)
    act(() => {
      snap2 = ref.current.snapshotPassageAudio()
    })
    expect(snap2.length).toBe(8 * 1600)
  })

  it('endPassage returns the full buffer and stops accumulation', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    act(() => ref.current.beginPassage())
    act(() => {
      for (let i = 0; i < 4; i++) cap.firePcm(pcmBytes(new Array(1600).fill(0.2)))
    })
    let out: Float32Array = new Float32Array(0)
    act(() => {
      out = ref.current.endPassage()
    })
    expect(out.length).toBe(4 * 1600)
    // After endPassage, PCM is ignored (accumulation stopped) → a snapshot is empty.
    act(() => cap.firePcm(pcmBytes(new Array(1600).fill(0.2))))
    let snap: Float32Array = new Float32Array(1)
    act(() => {
      snap = ref.current.snapshotPassageAudio()
    })
    expect(snap.length).toBe(0)
  })

  it('resets sample count and buffer on beginPassage', async () => {
    const ref = mountRecorder()
    await act(async () => {
      await ref.current.start()
    })
    act(() => ref.current.beginPassage())
    act(() => {
      for (let i = 0; i < 12; i++) cap.firePcm(pcmBytes(new Array(1600).fill(0.2)))
    })
    expect(ref.current.passageSampleCount).toBeGreaterThan(0)

    // A fresh passage clears the tally and the accumulated audio.
    act(() => ref.current.beginPassage())
    expect(ref.current.passageSampleCount).toBe(0)
    let snap: Float32Array = new Float32Array(1)
    act(() => {
      snap = ref.current.snapshotPassageAudio()
    })
    expect(snap.length).toBe(0)
  })
})

describe('useVoiceRecorder — openDeviceId', () => {
  it('reports the open track\'s device, and undefined once stopped', async () => {
    const ref = mountRecorder()
    expect(ref.current.openDeviceId()).toBeUndefined()

    await act(async () => {
      await ref.current.start()
    })
    expect(ref.current.openDeviceId()).toBe('os-default')

    act(() => ref.current.stop())
    expect(ref.current.openDeviceId()).toBeUndefined()

    await act(async () => {
      await ref.current.start('usb-mic')
    })
    expect(ref.current.openDeviceId()).toBe('usb-mic')
  })
})
