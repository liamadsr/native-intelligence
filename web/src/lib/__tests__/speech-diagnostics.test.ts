import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModuleInfo, VoiceStatus } from '@/lib/tauri-bridge'

const bridge = vi.hoisted(() => ({
  appVersion: vi.fn<() => Promise<string>>(),
  systemInfo: vi.fn<() => Promise<unknown>>(),
  moduleLogTail: vi.fn<(id: string) => Promise<string[]>>(),
}))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: bridge }))

import {
  __resetDesktopContextForTests,
  desktopContext,
  LOG_TAIL_MAX_CHARS,
  logTail,
  snapshotProps,
} from '@/lib/speech-diagnostics'

beforeEach(() => {
  __resetDesktopContextForTests()
  bridge.appVersion.mockReset().mockResolvedValue('0.2.73')
  bridge.systemInfo.mockReset().mockResolvedValue({
    macosVersion: '15.6.1',
    chip: 'Apple M2 Max',
    arch: 'aarch64',
    memoryBytes: 34_359_738_368,
    rosetta: false,
  })
  bridge.moduleLogTail.mockReset()
})

describe('desktopContext', () => {
  it('the Mac and the app, for every event', async () => {
    expect(await desktopContext()).toEqual({
      desktop_app_version: '0.2.73',
      macos_version: '15.6.1',
      mac_chip: 'Apple M2 Max',
      mac_arch: 'aarch64',
      mac_memory_gb: 32,
      mac_rosetta: false,
    })
  })

  it('a desktop before 0.2.73 (no system_info): the app version, the rest null', async () => {
    bridge.appVersion.mockResolvedValue('0.2.72')
    bridge.systemInfo.mockRejectedValue(new Error('command system_info not found'))
    expect(await desktopContext()).toEqual({
      desktop_app_version: '0.2.72',
      macos_version: null,
      mac_chip: null,
      mac_arch: null,
      mac_memory_gb: null,
      mac_rosetta: null,
    })
  })

  it('is read once per page', async () => {
    await desktopContext()
    await desktopContext()
    expect(bridge.systemInfo).toHaveBeenCalledTimes(1)
  })
})

describe('snapshotProps', () => {
  const stt: LocalModuleInfo = {
    id: 'local-stt',
    version: '2026-09-25',
    enabled: true,
    state: 'error',
    progress: null,
    downloadBytes: 806_885_088,
    assetsPresent: false,
    error: 'download of asr.gguf failed: HTTP 503',
  }
  const tts: LocalModuleInfo = { ...stt, id: 'local-tts', state: 'ready', assetsPresent: true, error: null }
  const voice: VoiceStatus = { available: true, dictation: false, conversation: false, stt: 'error', tts: 'ready' }

  it('each model and the voice status, and the person properties a profile shows', () => {
    expect(snapshotProps([stt, tts], voice)).toEqual({
      modules_reported: 2,
      local_stt_state: 'error',
      local_stt_enabled: true,
      local_stt_has_files: false,
      local_stt_error: 'download of asr.gguf failed: HTTP 503',
      local_stt_version: '2026-09-25',
      local_tts_state: 'ready',
      local_tts_enabled: true,
      local_tts_has_files: true,
      local_tts_error: null,
      local_tts_version: '2026-09-25',
      voice_available: true,
      voice_dictation: false,
      voice_conversation: false,
      voice_stt: 'error',
      voice_tts: 'ready',
      voice_reason: null,
      $set: {
        local_stt_state: 'error',
        local_stt_error: 'download of asr.gguf failed: HTTP 503',
        local_tts_state: 'ready',
        local_tts_error: null,
        voice_dictation: false,
        voice_conversation: false,
      },
    })
  })

  it('a desktop without modules says so', () => {
    expect(snapshotProps([], null)).toEqual({ modules_reported: 0, $set: {} })
  })
})

describe('logTail', () => {
  it('the module’s lines, joined', async () => {
    bridge.moduleLogTail.mockResolvedValue(['[modules] local-stt warming up', '[module:local-stt] dyld: Symbol not found'])
    expect(await logTail('local-stt')).toBe('[modules] local-stt warming up\n[module:local-stt] dyld: Symbol not found')
    expect(bridge.moduleLogTail).toHaveBeenCalledWith('local-stt')
  })

  it('keeps the newest lines when it is long', async () => {
    bridge.moduleLogTail.mockResolvedValue(Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`))
    const tail = (await logTail('local-stt'))!
    expect(tail.length).toBe(LOG_TAIL_MAX_CHARS)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.endsWith(`line 399 ${'x'.repeat(20)}`)).toBe(true)
  })

  it('null on a desktop without the command, or one that does not answer', async () => {
    bridge.moduleLogTail.mockRejectedValue(new Error('command module_log_tail not found'))
    expect(await logTail('local-stt')).toBeNull()

    vi.useFakeTimers()
    bridge.moduleLogTail.mockReturnValue(new Promise(() => {}))
    const pending = logTail('local-stt', 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toBeNull()
    vi.useRealTimers()
  })
})
