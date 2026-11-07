import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract v1 for local modules + the local transcription engine.
 * The website deploys ahead of the desktop, so every addition must be inert on
 * a desktop that predates it: modules_list missing → [], and a Deepgram
 * start_recording must send exactly the args it always has.
 *
 * Hermetic: @tauri-apps/api is mocked directly (no shared bridge loader).
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

const { tauriBridge } = await import('../tauri-bridge')
const { listLocalModules, getLocalModule, isLocalModuleUsable, formatDownloadSize } = await import('../local-modules')

const stt = {
  id: 'local-stt', version: '97a15af', enabled: true, state: 'ready' as const, progress: null,
  downloadBytes: 807_000_000, assetsPresent: true, error: null,
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.desktop = true
})

describe('tauriBridge.startRecording', () => {
  it('sends only captureSystemAudio for a Deepgram start (the desktop picks the mic)', async () => {
    tauri.invoke.mockResolvedValue({ sessionId: 's' })
    await tauriBridge.startRecording({ captureSystemAudio: true })
    expect(tauri.invoke).toHaveBeenCalledWith('start_recording', { captureSystemAudio: true })
    expect(Object.keys(tauri.invoke.mock.calls[0][1])).toEqual(['captureSystemAudio'])
  })

  it('adds transcription only when asked for the local engine', async () => {
    tauri.invoke.mockResolvedValue({ sessionId: 's', transcriptionEngine: 'local' })
    const session = await tauriBridge.startRecording({ captureSystemAudio: false, transcription: 'local' })
    expect(tauri.invoke).toHaveBeenCalledWith('start_recording', {
      captureSystemAudio: false,
      transcription: 'local',
    })
    expect(session.transcriptionEngine).toBe('local')
  })
})

describe('tauriBridge local-module commands', () => {
  it('modulesList → the desktop list', async () => {
    tauri.invoke.mockResolvedValue([stt])
    expect(await tauriBridge.modulesList()).toEqual([stt])
    expect(tauri.invoke).toHaveBeenCalledWith('modules_list', undefined)
  })

  it('modulesList → [] on a desktop without the command (invoke rejects) or a junk answer', async () => {
    tauri.invoke.mockRejectedValueOnce(new Error('command modules_list not found'))
    expect(await tauriBridge.modulesList()).toEqual([])
    tauri.invoke.mockResolvedValueOnce(null)
    expect(await tauriBridge.modulesList()).toEqual([])
  })

  it('enable / disable / remove assets pass the module id', async () => {
    tauri.invoke.mockResolvedValue(stt)
    await tauriBridge.moduleEnable('local-stt')
    await tauriBridge.moduleDisable('local-stt')
    await tauriBridge.moduleRemoveAssets('local-stt')
    expect(tauri.invoke.mock.calls).toEqual([
      ['module_enable', { id: 'local-stt' }],
      ['module_disable', { id: 'local-stt' }],
      ['module_remove_assets', { id: 'local-stt' }],
    ])
  })

  it('listeners subscribe to the contract event names and unwrap payloads', async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>()
    tauri.listen.mockImplementation(async (event: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(event, cb)
      return () => {}
    })
    const got: unknown[] = []
    await tauriBridge.onModuleStatus((p) => got.push(['status', p]))
    await tauriBridge.onSttMessage((p) => got.push(['message', p]))
    await tauriBridge.onSttEngineChanged((p) => got.push(['changed', p]))
    await tauriBridge.onSttFinished((p) => got.push(['finished', p]))
    await tauriBridge.onAudioPcm('system', (p) => got.push(['pcm', p]))
    expect([...handlers.keys()]).toEqual([
      'module://status', 'stt://message', 'stt://engine-changed', 'stt://finished', 'audio://system',
    ])
    handlers.get('module://status')!({ payload: stt })
    handlers.get('stt://message')!({ payload: { session: 's1', stream: 'mic', message: { type: 'SpeechStarted' } } })
    handlers.get('stt://engine-changed')!({ payload: { session: 's1', engine: 'deepgram', reason: 'crash' } })
    handlers.get('stt://finished')!({ payload: { session: 's1' } })
    handlers.get('audio://system')!({ payload: [1, 2] })
    expect(got).toEqual([
      ['status', stt],
      // Session ids pass through untouched (the service filters on them).
      ['message', { session: 's1', stream: 'mic', message: { type: 'SpeechStarted' } }],
      ['changed', { session: 's1', engine: 'deepgram', reason: 'crash' }],
      ['finished', { session: 's1' }],
      ['pcm', [1, 2]],
    ])
  })
})

describe('local-modules client', () => {
  it('reads as "no modules" in a browser without touching the bridge', async () => {
    tauri.desktop = false
    expect(await listLocalModules()).toEqual([])
    expect(await getLocalModule('local-stt')).toBeNull()
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it('finds a module by id on a desktop that has it', async () => {
    tauri.invoke.mockResolvedValue([stt, { ...stt, id: 'local-tts' }])
    expect(await getLocalModule('local-stt')).toEqual(stt)
    expect(await getLocalModule('nope')).toBeNull()
  })

  it('usable = enabled AND ready', () => {
    expect(isLocalModuleUsable(stt)).toBe(true)
    expect(isLocalModuleUsable({ ...stt, enabled: false })).toBe(false)
    expect(isLocalModuleUsable({ ...stt, state: 'warming' })).toBe(false)
    expect(isLocalModuleUsable(null)).toBe(false)
  })

  it('formats the download size like the settings copy', () => {
    expect(formatDownloadSize(807_000_000)).toBe('~800 MB')
    expect(formatDownloadSize(774_512_128)).toBe('~800 MB')
    expect(formatDownloadSize(1_240_000_000)).toBe('~1.2 GB')
    expect(formatDownloadSize(960_000_000)).toBe('~1 GB')
    expect(formatDownloadSize(45_200_000)).toBe('~45 MB')
    expect(formatDownloadSize(144_230_000)).toBe('~140 MB')
    expect(formatDownloadSize(496_000_000)).toBe('~500 MB')
    expect(formatDownloadSize(0)).toBeNull()
    expect(formatDownloadSize(undefined)).toBeNull()
  })
})
