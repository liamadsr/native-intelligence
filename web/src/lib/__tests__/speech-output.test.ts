import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModuleInfo } from '@/lib/tauri-bridge'

const bridge = vi.hoisted(() => ({
  ttsSpeak: vi.fn(async () => {}),
  ttsCancel: vi.fn(async () => {}),
  ttsPrepare: vi.fn(async () => {}),
  ttsVoices: vi.fn(async () => [{ id: 'tana', name: 'Tana', description: '', default: true }]),
  onTtsState: vi.fn(() => () => {}),
}))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: bridge }))
vi.mock('@/hooks/use-local-module', () => ({ useLocalModule: () => ({ info: null }) }))

import { resolveSpeechOutput, speechOutput } from '@/lib/speech-output'
import { describeModuleError } from '@/lib/local-modules'

const tts = (over: Partial<LocalModuleInfo>): LocalModuleInfo => ({
  id: 'local-tts',
  version: '2026-09-26',
  enabled: true,
  state: 'ready',
  progress: null,
  downloadBytes: 144_227_442,
  assetsPresent: true,
  error: null,
  ...over,
})

beforeEach(() => {
  for (const fn of Object.values(bridge)) fn.mockClear()
})

describe('resolveSpeechOutput', () => {
  it('the local model speaks once it is on and ready', () => {
    expect(resolveSpeechOutput({ local: tts({}) })).toEqual({ available: true, engine: 'local' })
  })

  it('nothing speaks while it downloads, sets up, failed, is off, or is missing (no cloud engine yet)', () => {
    for (const local of [
      tts({ state: 'downloading', progress: 0.4 }),
      tts({ state: 'warming' }),
      tts({ state: 'error', error: 'x' }),
      tts({ enabled: false }),
      null,
    ]) {
      expect(resolveSpeechOutput({ local })).toEqual({ available: false, engine: null })
    }
  })
})

describe('speechOutput', () => {
  it('goes to the desktop’s local engine, passing the voice only when one is chosen', async () => {
    await speechOutput.speak({ id: 'u1', text: 'Hello.' })
    await speechOutput.speak({ id: 'u2', text: 'Hi.', voice: 'aba' })
    expect(bridge.ttsSpeak.mock.calls).toEqual([[{ id: 'u1', text: 'Hello.' }], [{ id: 'u2', text: 'Hi.', voice: 'aba' }]])

    await speechOutput.cancel()
    await speechOutput.prepare()
    expect(await speechOutput.voices()).toHaveLength(1)
    const cb = () => {}
    speechOutput.onState(cb)
    expect(bridge.ttsCancel).toHaveBeenCalledTimes(1)
    expect(bridge.ttsPrepare).toHaveBeenCalledTimes(1)
    expect(bridge.onTtsState).toHaveBeenCalledWith(cb)
  })
})

describe('describeModuleError', () => {
  it('turns the desktop’s log wording into something to act on', () => {
    expect(describeModuleError('not enough disk space: 1880 MB needed, 412 MB free')).toBe(
      'Not enough disk space. Free up about 1.5 GB, then try again.',
    )
    expect(describeModuleError('download of asr.gguf failed: HTTP 503')).toMatch(/interrupted/)
    expect(describeModuleError('download of asr.gguf failed: expected 10 bytes, got 4')).toMatch(/interrupted/)
    expect(describeModuleError('asr.gguf failed its checksum — the download was discarded')).toMatch(/damaged/)
    expect(describeModuleError('sidecar executable not found')).toMatch(/Update Native Intelligence/)
    expect(describeModuleError('sidecar did not answer ready in time')).toMatch(/couldn’t start/)
    expect(describeModuleError('io: permission denied')).toMatch(/saving it/)
    expect(describeModuleError('Something new')).toBe('Something new')
  })
})
