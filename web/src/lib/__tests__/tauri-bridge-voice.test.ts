import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for chat voice (docs/plans/chat-voice.md §3.3). The website
 * ships ahead of the desktop, so every wrapper must be inert on a desktop
 * without the voice_* commands (voice_status → unavailable), and never touch
 * Tauri in the browser.
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

const { tauriBridge, VoiceRefusedError, VOICE_UNAVAILABLE } = await import('../tauri-bridge')

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.desktop = true
})

describe('voice bridge: commands', () => {
  it('voiceStatus passes a well-formed answer through', async () => {
    tauri.invoke.mockResolvedValueOnce({
      available: true,
      dictation: true,
      conversation: false,
      stt: 'ready',
      tts: 'downloading',
      reason: 'tts downloading',
    })
    expect(await tauriBridge.voiceStatus()).toEqual({
      available: true,
      dictation: true,
      conversation: false,
      stt: 'ready',
      tts: 'downloading',
      reason: 'tts downloading',
    })
    expect(tauri.invoke).toHaveBeenCalledWith('voice_status', undefined)
  })

  it('voiceStatus carries noiseProfiles and readyFlag when the desktop has them (absent on 0.2.45)', async () => {
    const base = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' }
    tauri.invoke.mockResolvedValueOnce({ ...base, noiseProfiles: ['quiet', 'noisy', 'auto', 7], readyFlag: true })
    expect(await tauriBridge.voiceStatus()).toEqual({ ...base, noiseProfiles: ['quiet', 'noisy', 'auto'], readyFlag: true })
    tauri.invoke.mockResolvedValueOnce(base)
    const old = await tauriBridge.voiceStatus()
    expect(old).toEqual(base)
    expect('noiseProfiles' in old || 'readyFlag' in old).toBe(false)
    tauri.invoke.mockResolvedValueOnce({ ...base, noiseProfiles: 'noisy', readyFlag: 'yes' })
    expect(await tauriBridge.voiceStatus()).toEqual(base)
  })

  it('voiceStatus: a desktop without the command, or junk, reads as unavailable', async () => {
    tauri.invoke.mockRejectedValueOnce(new Error('command voice_status not found'))
    expect(await tauriBridge.voiceStatus()).toEqual(VOICE_UNAVAILABLE)
    tauri.invoke.mockResolvedValueOnce(null)
    expect(await tauriBridge.voiceStatus()).toEqual(VOICE_UNAVAILABLE)
    // Mode flags never outlive `available`, and unknown module states → error.
    tauri.invoke.mockResolvedValueOnce({ available: false, dictation: true, conversation: true, stt: 'bogus', tts: 'ready' })
    expect(await tauriBridge.voiceStatus()).toMatchObject({ available: false, dictation: false, conversation: false, stt: 'error' })
  })

  it('voiceStart sends the session, mode and settings flat (like tts_speak)', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    await tauriBridge.voiceStart({ sessionId: 's1', mode: 'dictation' })
    await tauriBridge.voiceStart({ sessionId: 's2', mode: 'conversation', endSilenceMs: 700, bargeIn: false })
    await tauriBridge.voiceStart({ sessionId: 's3', mode: 'conversation', noiseProfile: 'noisy' })
    expect(tauri.invoke.mock.calls).toEqual([
      ['voice_start', { sessionId: 's1', mode: 'dictation' }],
      ['voice_start', { sessionId: 's2', mode: 'conversation', endSilenceMs: 700, bargeIn: false }],
      ['voice_start', { sessionId: 's3', mode: 'conversation', noiseProfile: 'noisy' }],
    ])
  })

  it('voiceStart rejects VoiceRefusedError with the refusal code', async () => {
    for (const code of ['recording', 'busy', 'not_ready', 'mic_denied', 'unavailable'] as const) {
      tauri.invoke.mockRejectedValueOnce(code)
      const err = await tauriBridge.voiceStart({ sessionId: 's', mode: 'dictation' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(VoiceRefusedError)
      expect((err as InstanceType<typeof VoiceRefusedError>).code).toBe(code)
    }
    tauri.invoke.mockRejectedValueOnce(new Error('mic_denied: TCC denied'))
    const denied = await tauriBridge.voiceStart({ sessionId: 's', mode: 'dictation' }).catch((e: unknown) => e)
    expect((denied as InstanceType<typeof VoiceRefusedError>).code).toBe('mic_denied')
    tauri.invoke.mockRejectedValueOnce('Command voice_start not found')
    const old = await tauriBridge.voiceStart({ sessionId: 's', mode: 'dictation' }).catch((e: unknown) => e)
    expect((old as InstanceType<typeof VoiceRefusedError>).code).toBe('unavailable')
  })

  it('stop / cancel / mute / aside call their commands and never reject', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    await tauriBridge.voiceStop('s1')
    await tauriBridge.voiceCancel('s1')
    await tauriBridge.voiceSetMuted('s1', true)
    await tauriBridge.voiceSetAside('s1', true, "What's up?")
    await tauriBridge.voiceSetAside('s1', false)
    expect(tauri.invoke.mock.calls).toEqual([
      ['voice_stop', { sessionId: 's1' }],
      ['voice_cancel', { sessionId: 's1' }],
      ['voice_set_muted', { sessionId: 's1', muted: true }],
      ['voice_set_aside', { sessionId: 's1', aside: true, text: "What's up?" }],
      ['voice_set_aside', { sessionId: 's1', aside: false }],
    ])
    // A desktop without the command (0.2.45 has no voice_set_aside): no harm.
    tauri.invoke.mockRejectedValue(new Error('command not found'))
    await expect(tauriBridge.voiceStop('s1')).resolves.toBeUndefined()
    await expect(tauriBridge.voiceCancel('s1')).resolves.toBeUndefined()
    await expect(tauriBridge.voiceSetMuted('s1', false)).resolves.toBeUndefined()
    await expect(tauriBridge.voiceSetAside('s1', false)).resolves.toBeUndefined()
  })

  it('Interactive mode: voice_status `interactive` passes through only with voice available', async () => {
    const base = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' }
    tauri.invoke.mockResolvedValueOnce({ ...base, interactive: true })
    expect(await tauriBridge.voiceStatus()).toEqual({ ...base, interactive: true })
    tauri.invoke.mockResolvedValueOnce({ ...base, interactive: 'yes' })
    expect(await tauriBridge.voiceStatus()).toEqual(base)
    tauri.invoke.mockResolvedValueOnce({ ...base, available: false, interactive: true })
    expect(await tauriBridge.voiceStatus()).not.toHaveProperty('interactive')
  })

  it('Interactive mode: voiceStart with mode `interactive`; voiceSetBarge calls voice_set_barge and never rejects', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    await tauriBridge.voiceStart({ sessionId: 'i1', mode: 'interactive', endSilenceMs: 1200, noiseProfile: 'auto' })
    await tauriBridge.voiceSetBarge('i1', 'speech')
    await tauriBridge.voiceSetBarge('i1', 'wake')
    expect(tauri.invoke.mock.calls).toEqual([
      ['voice_start', { sessionId: 'i1', mode: 'interactive', endSilenceMs: 1200, noiseProfile: 'auto' }],
      ['voice_set_barge', { sessionId: 'i1', policy: 'speech' }],
      ['voice_set_barge', { sessionId: 'i1', policy: 'wake' }],
    ])
    // An unknown session, or a desktop without the command: no harm.
    tauri.invoke.mockRejectedValue(new Error('unknown_session'))
    await expect(tauriBridge.voiceSetBarge('gone', 'off')).resolves.toBeUndefined()
  })
})

describe('voice bridge: events', () => {
  function captureListeners() {
    const handlers = new Map<string, (e: { payload: unknown }) => void>()
    const unlisten = vi.fn()
    tauri.listen.mockImplementation(async (event: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(event, cb)
      return unlisten
    })
    return { handlers, unlisten }
  }

  it('listens on the seven voice:// events and passes only its own session, typed', async () => {
    const { handlers, unlisten } = captureListeners()
    const got: unknown[] = []
    const off = tauriBridge.onVoiceEvent('s1', (e) => got.push(e))
    // Each listener lazily imports @tauri-apps/api/event first.
    await vi.waitFor(() => expect(handlers.size).toBe(7))
    expect([...handlers.keys()].sort()).toEqual(
      [
        'voice://ended',
        'voice://interrupted',
        'voice://level',
        'voice://speech',
        'voice://state',
        'voice://transcript',
        'voice://turn',
      ].sort(),
    )
    const fire = (name: string, payload: unknown) => handlers.get(`voice://${name}`)!({ payload })
    fire('state', { sessionId: 's1', state: 'listening', echo: 'half_duplex' })
    fire('state', { sessionId: 's2', state: 'listening', echo: 'cancelling' }) // another session
    fire('transcript', { sessionId: 's1', turnId: 't1', text: 'hello', final: false })
    fire('turn', { sessionId: 's1', turnId: 't1', text: 'hello there' })
    fire('interrupted', { sessionId: 's1', turnId: 't1' })
    fire('level', { sessionId: 's1', mic: 1.7, agent: -1 })
    fire('ended', { sessionId: 's1', reason: 'stopped', text: 'hello there' })
    fire('state', { sessionId: 's1', state: 'bogus', echo: 'cancelling' }) // malformed
    fire('turn', null)
    // A readyFlag desktop's `ready` rides along; a non-boolean one is dropped.
    fire('state', { sessionId: 's1', state: 'muted', echo: 'cancelling', ready: false })
    fire('state', { sessionId: 's1', state: 'muted', echo: 'cancelling', ready: true })
    fire('state', { sessionId: 's1', state: 'listening', echo: 'cancelling', ready: 'yes' })
    // An auto desktop's `noiseMode` rides along too; anything else is dropped.
    fire('state', { sessionId: 's1', state: 'listening', echo: 'cancelling', ready: true, noiseMode: 'noisy' })
    fire('state', { sessionId: 's1', state: 'listening', echo: 'cancelling', noiseMode: 'loud' })
    expect(got).toEqual([
      { type: 'state', state: 'listening', echo: 'half_duplex' },
      { type: 'transcript', turnId: 't1', text: 'hello', final: false },
      { type: 'turn', turnId: 't1', text: 'hello there' },
      { type: 'interrupted', turnId: 't1' },
      { type: 'level', mic: 1, agent: 0 },
      { type: 'ended', reason: 'stopped', text: 'hello there' },
      { type: 'state', state: 'muted', echo: 'cancelling', ready: false },
      { type: 'state', state: 'muted', echo: 'cancelling', ready: true },
      { type: 'state', state: 'listening', echo: 'cancelling' },
      { type: 'state', state: 'listening', echo: 'cancelling', ready: true, noiseMode: 'noisy' },
      { type: 'state', state: 'listening', echo: 'cancelling' },
    ])
    off()
    expect(unlisten).toHaveBeenCalledTimes(7)
    await settle()
    fire('turn', { sessionId: 's1', turnId: 't2', text: 'late' })
    expect(got).toHaveLength(11)
  })

  it('with no session, takes every session’s; `only` listens to just those events (the overlay’s bubble glow)', async () => {
    const { handlers, unlisten } = captureListeners()
    const got: unknown[] = []
    const off = tauriBridge.onVoiceEvent(null, (e) => got.push(e), ['level'])
    await vi.waitFor(() => expect(handlers.size).toBe(1))
    expect([...handlers.keys()]).toEqual(['voice://level'])
    const fire = (payload: unknown) => handlers.get('voice://level')!({ payload })
    fire({ sessionId: 's1', mic: 0.02, agent: 0.01 })
    fire({ sessionId: 's2', mic: 0, agent: 0.4 })
    fire({ mic: 'loud', agent: 3 }) // no session, junk levels: still clipped to 0–1
    fire(null)
    expect(got).toEqual([
      { type: 'level', mic: 0.02, agent: 0.01 },
      { type: 'level', mic: 0, agent: 0.4 },
      { type: 'level', mic: 0, agent: 1 },
    ])
    off()
    expect(unlisten).toHaveBeenCalledTimes(1)
    fire({ sessionId: 's1', mic: 0.5, agent: 0.5 })
    expect(got).toHaveLength(3)
  })

  it('unsubscribed before the listeners attached: none stays attached', async () => {
    const { handlers, unlisten } = captureListeners()
    const off = tauriBridge.onVoiceEvent('s1', () => {})
    off()
    await settle()
    // Either never attached, or detached as soon as it did.
    expect(unlisten.mock.calls.length).toBe(handlers.size)
  })

  it('unsubscribed while the listeners attach: each is detached as it lands', async () => {
    const handlers = new Map<string, unknown>()
    const unlisten = vi.fn()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    tauri.listen.mockImplementation(async (event: string, cb: unknown) => {
      handlers.set(event, cb)
      await gate
      return unlisten
    })
    const off = tauriBridge.onVoiceEvent('s1', () => {})
    await vi.waitFor(() => expect(handlers.size).toBe(7))
    off()
    release()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(7))
  })

  it('tolerates a build without the events', async () => {
    tauri.listen.mockRejectedValue(new Error('no event'))
    const off = tauriBridge.onVoiceEvent('s1', () => {})
    await settle()
    expect(() => off()).not.toThrow()
  })
})

describe('voice bridge: Voice focus (speech audio, voice_log)', () => {
  const base = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' }

  it('voice_status `speechAudio` passes through only as `true` with voice available', async () => {
    tauri.invoke.mockResolvedValueOnce({ ...base, speechAudio: true })
    expect(await tauriBridge.voiceStatus()).toEqual({ ...base, speechAudio: true })
    tauri.invoke.mockResolvedValueOnce({ ...base, speechAudio: 'yes' })
    expect(await tauriBridge.voiceStatus()).toEqual(base)
    tauri.invoke.mockResolvedValueOnce({ ...base, available: false, speechAudio: true })
    expect(await tauriBridge.voiceStatus()).not.toHaveProperty('speechAudio')
  })

  it('voiceStart sends `speechAudio` only when true', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    await tauriBridge.voiceStart({ sessionId: 'a', mode: 'conversation', speechAudio: true })
    await tauriBridge.voiceStart({ sessionId: 'b', mode: 'conversation', speechAudio: false })
    await tauriBridge.voiceStart({ sessionId: 'c', mode: 'interactive' })
    expect(tauri.invoke.mock.calls).toEqual([
      ['voice_start', { sessionId: 'a', mode: 'conversation', speechAudio: true }],
      ['voice_start', { sessionId: 'b', mode: 'conversation' }],
      ['voice_start', { sessionId: 'c', mode: 'interactive' }],
    ])
  })

  it('a refused `unavailable: lid_closed` keeps its detail for the message', async () => {
    tauri.invoke.mockRejectedValueOnce('unavailable: lid_closed')
    const err = await tauriBridge.voiceStart({ sessionId: 's', mode: 'conversation' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceRefusedError)
    expect((err as InstanceType<typeof VoiceRefusedError>).code).toBe('unavailable')
    // (The code may repeat: voiceRefusalInfo strips every leading copy.)
    expect((err as Error).message).toMatch(/^unavailable: (unavailable: )?lid_closed$/)
  })

  it('voiceLog writes the line (cut to 400) and never surfaces a desktop without voice_log', async () => {
    tauri.invoke.mockResolvedValueOnce(undefined)
    await tauriBridge.voiceLog('conv-1', 'turn t3 dur=2.4s')
    expect(tauri.invoke).toHaveBeenLastCalledWith('voice_log', { sessionId: 'conv-1', line: 'turn t3 dur=2.4s' })
    tauri.invoke.mockResolvedValueOnce(undefined)
    await tauriBridge.voiceLog('conv-1', 'x'.repeat(900))
    expect((tauri.invoke.mock.calls[1][1] as { line: string }).line).toHaveLength(400)
    tauri.invoke.mockRejectedValueOnce(new Error('Command voice_log not found'))
    await expect(tauriBridge.voiceLog('conv-1', 'line')).resolves.toBeUndefined()
  })

  it('voice://speech: chunks and closes pass typed; anything off-contract is dropped whole', async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>()
    tauri.listen.mockImplementation(async (event: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(event, cb)
      return vi.fn()
    })
    const got: unknown[] = []
    const off = tauriBridge.onVoiceEvent('s1', (e) => got.push(e), ['speech'])
    await vi.waitFor(() => expect(handlers.size).toBe(1))
    const fire = (payload: unknown) => handlers.get('voice://speech')!({ payload })
    const chunk = { sessionId: 's1', type: 'speech', turnId: 't1', seq: 0, startMs: 120, sampleRate: 16000, pcm: 'AAD/fw==', end: false }
    fire(chunk)
    fire({ sessionId: 's1', turnId: 't1', seq: 1, end: true, outcome: 'turn' })
    fire({ sessionId: 's1', turnId: 't2', seq: 0, end: true, outcome: 'abandoned' })
    // Off-contract:
    fire({ ...chunk, sessionId: 's2' }) // another session
    fire({ ...chunk, turnId: '' })
    fire({ ...chunk, seq: -1 })
    fire({ ...chunk, seq: 1.5 })
    fire({ ...chunk, sampleRate: 48000 })
    fire({ ...chunk, pcm: '' })
    fire({ ...chunk, pcm: 'not base64!' })
    fire({ ...chunk, startMs: Number.NaN })
    fire({ ...chunk, end: 'no' })
    fire({ sessionId: 's1', turnId: 't1', seq: 2, end: true, outcome: 'maybe' })
    fire({ sessionId: 's1', turnId: 't1', seq: 2, end: true })
    expect(got).toEqual([
      { type: 'speech', turnId: 't1', seq: 0, end: false, startMs: 120, sampleRate: 16000, pcm: 'AAD/fw==' },
      { type: 'speech', turnId: 't1', seq: 1, end: true, outcome: 'turn' },
      { type: 'speech', turnId: 't2', seq: 0, end: true, outcome: 'abandoned' },
    ])
    off()
  })
})

describe('audio bridge: the mic sending only silence (audio://input-silent)', () => {
  it('passes well-formed episodes, drops junk, and is inert in the browser', async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    tauri.listen.mockImplementation(async (event: string, cb: (e: { payload: unknown }) => void) => {
      if (event === 'audio://input-silent') handler = cb
      return vi.fn()
    })
    const got: unknown[] = []
    const off = tauriBridge.onInputSilent((e) => got.push(e))
    await vi.waitFor(() => expect(handler).not.toBeNull())
    handler!({ payload: { deviceId: 'usb-1', name: 'Shure MV7', silent: true } })
    handler!({ payload: { deviceId: null, name: 'Mic', silent: false } })
    handler!({ payload: { deviceId: 7, name: 'Mic', silent: true } })
    handler!({ payload: { deviceId: 'a', silent: true } })
    handler!({ payload: { deviceId: 'a', name: 'Mic', silent: 'yes' } })
    handler!({ payload: null })
    expect(got).toEqual([
      { deviceId: 'usb-1', name: 'Shure MV7', silent: true },
      { deviceId: null, name: 'Mic', silent: false },
    ])
    off()
    tauri.desktop = false
    tauri.listen.mockClear()
    tauriBridge.onInputSilent(() => {})()
    expect(tauri.listen).not.toHaveBeenCalled()
  })
})

it('never touches Tauri in the browser', async () => {
  tauri.desktop = false
  await tauriBridge.voiceLog('s', 'line')
  expect(await tauriBridge.voiceStatus()).toEqual(VOICE_UNAVAILABLE)
  await expect(tauriBridge.voiceStart({ sessionId: 's', mode: 'dictation' })).rejects.toMatchObject({ code: 'unavailable' })
  await tauriBridge.voiceStop('s')
  await tauriBridge.voiceCancel('s')
  await tauriBridge.voiceSetMuted('s', true)
  await tauriBridge.voiceSetAside('s', true)
  await tauriBridge.voiceSetBarge('s', 'speech')
  tauriBridge.onVoiceEvent('s', () => {})()
  expect(tauri.invoke).not.toHaveBeenCalled()
  expect(tauri.listen).not.toHaveBeenCalled()
})
