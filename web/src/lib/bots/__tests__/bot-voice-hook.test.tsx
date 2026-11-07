// @vitest-environment jsdom
/**
 * useBotVoice and the crew behind it (lib/bots/bot-voice.ts), over a mocked
 * desktop bridge:
 *
 *   • a face speaks in its voice in this window's crew, handed over by the
 *     crew (useBotVoiceCrew, as AgentInfraHost does), live: a face joining the
 *     crew parts two that shared a voice, one leaving gives it back, and the
 *     crew going gives every face its own again;
 *   • undefined while the desktop is asked, null with no voices and off the
 *     desktop, as before the crew.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VOICES = ['aba', 'cha', 'ush', 'chichi', 'lori', 'lowli', 'tana', 'milton'].map((id) => ({
  id,
  name: id,
  description: '',
  default: id === 'tana',
}))
const env = vi.hoisted(() => ({ desktop: true, voices: [] as unknown[], asked: 0, hold: null as Promise<void> | null }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/tauri-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-bridge')>()),
  tauriBridge: {
    ttsVoices: async () => {
      env.asked++
      if (env.hold) await env.hold
      return env.voices
    },
  },
}))

import { __resetBotVoicesForTests, readBotVoiceCrew, useBotVoice, useBotVoiceCrew, voiceForCharacter } from '../bot-voice'

const FACES = BOT_CHARACTERS.map((c) => c.type)
/** The voices in dealing order: the default first, then the rest as listed. */
const DEALT = [...VOICES.filter((v) => v.default), ...VOICES.filter((v) => !v.default)].map((v) => v.id)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  __resetBotVoicesForTests()
  Object.assign(env, { desktop: true, voices: VOICES, asked: 0, hold: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** A speaker's voice, as the bubble asks for it. */
function Voice({ face }: { face: string }) {
  const voice = useBotVoice(face)
  return h('span', { 'data-face': face, 'data-voice': voice === undefined ? 'asking' : String(voice) })
}
/** AgentInfraHost's part: its faces are the crew. */
function Crew({ cast }: { cast: readonly string[] }) {
  useBotVoiceCrew(cast)
  return null
}
const voiceOf = (face: string) => container.querySelector<HTMLElement>(`[data-face="${face}"]`)!.dataset.voice

async function render(cast: readonly string[] | null, faces: readonly string[]) {
  await act(async () => {
    root.render(h('div', null, cast ? h(Crew, { cast }) : null, ...faces.map((face) => h(Voice, { key: face, face }))))
  })
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

describe('useBotVoice — in the crew', () => {
  it('follows the crew live: parted while two share a voice, back to its own when it’s alone, and with no crew', async () => {
    const [first, ninth, second] = [FACES[0], FACES[8], FACES[1]]
    // No crew yet: each its own, so the first and the ninth share one.
    await render(null, [first, ninth])
    expect(voiceOf(first)).toBe(voiceForCharacter(first, VOICES))
    expect(voiceOf(ninth)).toBe(voiceOf(first))

    // Both in the crew: parted.
    await render([ninth, first], [first, ninth])
    expect(readBotVoiceCrew()).toEqual([first, ninth])
    expect(voiceOf(first)).toBe(DEALT[0])
    expect(voiceOf(ninth)).toBe(DEALT[1])

    // A face joining that wants the voice the ninth was given: the ninth moves on, nobody shares.
    await render([first, ninth, second], [first, ninth, second])
    expect(voiceOf(second)).toBe(DEALT[1])
    expect(voiceOf(ninth)).toBe(DEALT[2])

    // The first leaving: the ninth has its own voice back.
    await render([ninth], [ninth])
    expect(voiceOf(ninth)).toBe(voiceForCharacter(ninth, VOICES))

    // The crew gone (AgentInfraHost unmounted): nobody, every face its own.
    await render([first, ninth], [first, ninth])
    await render(null, [first, ninth])
    expect(readBotVoiceCrew()).toEqual([])
    expect(voiceOf(ninth)).toBe(voiceOf(first))
    // The desktop was asked once for all of it.
    expect(env.asked).toBe(1)
  })
})

describe('useBotVoice — before and without voices', () => {
  it('is undefined while the desktop is asked, then the voice', async () => {
    let release = () => {}
    env.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    await render([FACES[0], FACES[8]], [FACES[8]])
    expect(voiceOf(FACES[8])).toBe('asking')
    await act(async () => release())
    await render([FACES[0], FACES[8]], [FACES[8]])
    expect(voiceOf(FACES[8])).toBe(DEALT[1])
  })

  it('is null when the desktop has no voices, and off the desktop', async () => {
    env.voices = []
    await render([FACES[0], FACES[8]], [FACES[8]])
    expect(voiceOf(FACES[8])).toBe('null')
    act(() => root.unmount())
    root = createRoot(container)
    __resetBotVoicesForTests()
    Object.assign(env, { desktop: false, voices: VOICES })
    await render([FACES[0], FACES[8]], [FACES[8]])
    expect(voiceOf(FACES[8])).toBe('null')
    expect(env.asked).toBe(1)
  })
})
