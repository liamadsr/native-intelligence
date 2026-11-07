import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for read-aloud (the desktop's local-tts module). The website
 * ships ahead of the desktop, so every wrapper must be inert on a desktop
 * without the tts_* commands, and never touch Tauri in the browser.
 *
 * Hermetic: @tauri-apps/api is mocked directly.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

const { tauriBridge, TtsRefusedError } = await import('../tauri-bridge')
const { LOCAL_TTS_MODULE_ID } = await import('../local-modules')

/**
 * A few macrotasks for promise chains already under way. The bridge imports
 * @tauri-apps lazily and, under a loaded full suite, that import can take
 * longer than any fixed count, so a test that needs the listener attached
 * waits for it with vi.waitFor instead.
 */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.desktop = true
})

describe('read-aloud bridge', () => {
  it('the module id', () => {
    expect(LOCAL_TTS_MODULE_ID).toBe('local-tts')
  })

  it('ttsSpeak sends id + text, and voice only when given', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    await tauriBridge.ttsSpeak({ id: 'm1:0', text: 'Hello.' })
    await tauriBridge.ttsSpeak({ id: 'm1:1', text: 'Again.', voice: 'alba' })
    expect(tauri.invoke.mock.calls).toEqual([
      ['tts_speak', { id: 'm1:0', text: 'Hello.' }],
      ['tts_speak', { id: 'm1:1', text: 'Again.', voice: 'alba' }],
    ])
  })

  it('ttsSpeak rejects with the refusal code', async () => {
    for (const code of ['recording', 'not_ready', 'unavailable', 'text_too_long'] as const) {
      tauri.invoke.mockRejectedValueOnce(code)
      const err = await tauriBridge.ttsSpeak({ id: 'x', text: 'Hi.' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TtsRefusedError)
      expect((err as InstanceType<typeof TtsRefusedError>).code).toBe(code)
    }
    tauri.invoke.mockRejectedValueOnce(new Error('not_ready: warming up'))
    const warming = await tauriBridge.ttsSpeak({ id: 'x', text: 'Hi.' }).catch((e: unknown) => e)
    expect((warming as InstanceType<typeof TtsRefusedError>).code).toBe('not_ready')
  })

  it('ttsSpeak on a desktop without the command → unavailable', async () => {
    tauri.invoke.mockRejectedValueOnce('Command tts_speak not found')
    const err = await tauriBridge.ttsSpeak({ id: 'x', text: 'Hi.' }).catch((e: unknown) => e)
    expect((err as InstanceType<typeof TtsRefusedError>).code).toBe('unavailable')
  })

  it('ttsCancel / ttsPrepare call their commands and never reject', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    await tauriBridge.ttsCancel()
    await tauriBridge.ttsPrepare()
    expect(tauri.invoke.mock.calls).toEqual([['tts_cancel', undefined], ['tts_prepare', undefined]])
    tauri.invoke.mockRejectedValue(new Error('command not found'))
    await expect(tauriBridge.ttsCancel()).resolves.toBeUndefined()
    await expect(tauriBridge.ttsPrepare()).resolves.toBeUndefined()
  })

  it('ttsVoices → the catalogue, cleaned up; [] without the command or on junk', async () => {
    tauri.invoke.mockResolvedValueOnce([
      { id: 'alba', name: 'Alba', description: 'Clear.', default: true },
      { id: 'anna' },
      { name: 'no id' },
      null,
    ])
    expect(await tauriBridge.ttsVoices()).toEqual([
      { id: 'alba', name: 'Alba', description: 'Clear.', default: true },
      { id: 'anna', name: 'anna', description: '', default: false },
    ])
    expect(tauri.invoke).toHaveBeenCalledWith('tts_voices', undefined)
    tauri.invoke.mockRejectedValueOnce(new Error('command tts_voices not found'))
    expect(await tauriBridge.ttsVoices()).toEqual([])
    tauri.invoke.mockResolvedValueOnce({ nope: true })
    expect(await tauriBridge.ttsVoices()).toEqual([])
  })

  it('ttsRate → the desktop’s Speed; null without the command, on junk, or in the browser', async () => {
    tauri.invoke.mockResolvedValueOnce(2)
    expect(await tauriBridge.ttsRate()).toBe(2)
    expect(tauri.invoke.mock.calls.at(-1)?.[0]).toBe('tts_rate')
    tauri.invoke.mockRejectedValueOnce('Command tts_rate not found')
    expect(await tauriBridge.ttsRate()).toBeNull()
    tauri.invoke.mockResolvedValueOnce('fast')
    expect(await tauriBridge.ttsRate()).toBeNull()
    tauri.desktop = false
    tauri.invoke.mockClear()
    expect(await tauriBridge.ttsRate()).toBeNull()
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it('ttsSetRate sends the rate and resolves to it as the desktop clamped it', async () => {
    tauri.invoke.mockResolvedValueOnce(4)
    expect(await tauriBridge.ttsSetRate(9)).toBe(4)
    expect(tauri.invoke).toHaveBeenLastCalledWith('tts_set_rate', { rate: 9 })
  })

  it('onTtsState listens on tts://state, passes valid payloads, and unsubscribes', async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    const unlisten = vi.fn()
    tauri.listen.mockImplementation(async (event: string, cb: (e: { payload: unknown }) => void) => {
      expect(event).toBe('tts://state')
      handler = cb
      return unlisten
    })
    const got: unknown[] = []
    const off = tauriBridge.onTtsState((p) => got.push(p))
    await vi.waitFor(() => expect(handler).not.toBeNull())
    handler!({ payload: { id: 'm1:0', state: 'speaking' } })
    handler!({ payload: { id: 'm1:0', state: 'done' } })
    handler!({ payload: { id: 'm1:1', state: 'error', error: 'device lost' } })
    handler!({ payload: { id: 'm1:2', state: 'bogus' } })
    handler!({ payload: null })
    expect(got).toEqual([
      { id: 'm1:0', state: 'speaking' },
      { id: 'm1:0', state: 'done' },
      { id: 'm1:1', state: 'error', error: 'device lost' },
    ])
    off()
    expect(unlisten).toHaveBeenCalledTimes(1)
    handler!({ payload: { id: 'm1:3', state: 'done' } })
    expect(got).toHaveLength(3)
  })

  it('onTtsState unsubscribed before the listener attached drops it', async () => {
    const unlisten = vi.fn()
    tauri.listen.mockImplementation(async () => unlisten)
    const off = tauriBridge.onTtsState(() => {})
    off()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })

  it('onTtsState tolerates a build without the event', async () => {
    tauri.listen.mockRejectedValue(new Error('no event'))
    const off = tauriBridge.onTtsState(() => {})
    await vi.waitFor(() => expect(tauri.listen).toHaveBeenCalled())
    await settle()
    expect(() => off()).not.toThrow()
  })

  it('onReadSelectionConvert listens on read-selection://convert and passes valid requests', async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    tauri.listen.mockImplementation(async (event: string, h: (e: { payload: unknown }) => void) => {
      expect(event).toBe('read-selection://convert')
      handler = h
      return () => {}
    })
    const seen: unknown[] = []
    const stop = tauriBridge.onReadSelectionConvert((p) => seen.push(p))
    await vi.waitFor(() => expect(handler).not.toBeNull())
    handler!({ payload: { run: 2, text: 'Hi.', app: 'com.microsoft.teams2' } })
    handler!({ payload: { run: '2', text: 'Hi.' } })
    handler!({ payload: { run: 3, text: 'No app.' } })
    expect(seen).toEqual([
      { run: 2, text: 'Hi.', app: 'com.microsoft.teams2' },
      { run: 3, text: 'No app.', app: '' },
    ])
    stop()
  })

  it('readSelectionSentences answers the run and never rejects', async () => {
    tauri.invoke.mockResolvedValueOnce(undefined)
    await tauriBridge.readSelectionSentences(4, ['Ann said: Hi.'])
    expect(tauri.invoke).toHaveBeenLastCalledWith('read_selection_sentences', { run: 4, sentences: ['Ann said: Hi.'] })
    tauri.invoke.mockRejectedValueOnce('Command read_selection_sentences not found')
    await expect(tauriBridge.readSelectionSentences(5, [])).resolves.toBeUndefined()
  })

  it('never touches Tauri in the browser', async () => {
    tauri.desktop = false
    await expect(tauriBridge.ttsSpeak({ id: 'x', text: 'Hi.' })).rejects.toMatchObject({ code: 'unavailable' })
    await tauriBridge.ttsCancel()
    await tauriBridge.ttsPrepare()
    expect(await tauriBridge.ttsVoices()).toEqual([])
    tauriBridge.onTtsState(() => {})()
    expect(tauri.invoke).not.toHaveBeenCalled()
    expect(tauri.listen).not.toHaveBeenCalled()
  })
})
