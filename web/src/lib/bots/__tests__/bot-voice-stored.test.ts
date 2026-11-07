/**
 * A bot's own voice (bots-v4.md Phase B2: migration 308's
 * `ai_team_member.voice`, lib/bots/bot-voice.ts).
 *
 *   • a stored voice wins: a face whose teammate chose a voice this device has
 *     speaks in it, in the crew or out of it, whatever the deal would have
 *     given it; a teammate's own choice (voiceForBot) wins over its face's;
 *   • a voice this device doesn't have falls back to Automatic: the face is
 *     dealt exactly as if it had chosen nothing, and nobody moves for it;
 *   • the deal skips taken voices: a face whose own voice a bot chose moves to
 *     the nearest free one; while there are enough voices no bot on Automatic
 *     shares one with any other bot; two bots may still choose the same one;
 *     past that, they share as evenly as they can;
 *   • deterministic: the same crew and choices in any order, the same voices;
 *   • one face speaks one voice: a teammate on Automatic that shares its face
 *     with one that chose a voice speaks in it (faceVoiceBesides says which);
 *     Automatic's sample (automaticVoice) leaves out the bot's own choice;
 *   • chosenVoicesOf reads the roster: per face, in its order, one entry per
 *     teammate; no face, no voice or a voice that isn't one adds nothing;
 *   • the crew handed over keeps its own faces' choices, voice ids only; the
 *     same again is the same crew.
 *
 * No character is named: faces are read off the catalogue by position, and
 * the voices are a list shaped like the desktop's (eight, the default partway
 * down), as in bot-voice.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'
import {
  __resetBotVoicesForTests,
  automaticVoice,
  chosenVoicesOf,
  faceVoiceBesides,
  readBotVoiceChoices,
  readBotVoiceCrew,
  setBotVoiceCrew,
  voiceForBot,
  voiceForCharacter,
  voiceForFace,
  voicesForCrew,
  type ChosenVoices,
} from '../bot-voice'

const voice = (id: string, isDefault = false) => ({ id, name: id, description: '', default: isDefault })
const VOICES = ['aba', 'cha', 'ush', 'chichi', 'lori', 'lowli', 'tana', 'milton'].map((id) => voice(id, id === 'tana'))
const FACES: readonly string[] = BOT_CHARACTERS.map((c) => c.type)
/** The voices in dealing order: the default first, then the rest as listed. */
const DEALT = [...VOICES.filter((v) => v.default), ...VOICES.filter((v) => !v.default)].map((v) => v.id)
const chose = (entries: Array<[string, string[]]>): ChosenVoices => new Map(entries)

/** A seeded generator (mulberry32): the same sample every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = seeded(308)
function shuffled<T>(from: readonly T[]): T[] {
  const pool = [...from]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool
}

describe('a stored voice wins', () => {
  it('a face whose teammate chose a voice speaks in it, whatever the deal would give it, and the others keep theirs', () => {
    const crew = [FACES[0], FACES[1], FACES[2]]
    expect(voicesForCrew(crew, VOICES).get(FACES[1])).toBe(DEALT[1])
    const dealt = voicesForCrew(crew, VOICES, chose([[FACES[1], ['milton']]]))
    expect(dealt.get(FACES[1])).toBe('milton')
    expect(dealt.get(FACES[0])).toBe(DEALT[0])
    expect(dealt.get(FACES[2])).toBe(DEALT[2])
  })

  it('out of the crew too, and before the crew is known', () => {
    expect(voiceForFace(FACES[5], [], VOICES, chose([[FACES[5], ['aba']]]))).toBe('aba')
    expect(voiceForFace(FACES[5], [FACES[0]], VOICES, chose([[FACES[5], ['aba']]]))).toBe('aba')
    // A built-in default face chooses like any other.
    expect(voiceForFace(FACES[0], [FACES[0]], VOICES, chose([[FACES[0], ['lori']]]))).toBe('lori')
  })

  it('a face worn by several teammates speaks in the first choice this device has, in the roster’s order', () => {
    const dealt = voicesForCrew([FACES[3]], VOICES, chose([[FACES[3], ['not-on-this-mac', 'cha', 'lori']]]))
    expect(dealt.get(FACES[3])).toBe('cha')
  })

  it('a teammate’s own choice wins over its face’s and over the deal', () => {
    const crew = [FACES[0], FACES[1]]
    const chosen = chose([[FACES[1], ['milton']]])
    expect(voiceForBot(FACES[1], 'lori', crew, VOICES, chosen)).toBe('lori')
    // On Automatic itself: its face's, which another teammate on that face chose.
    expect(voiceForBot(FACES[1], null, crew, VOICES, chosen)).toBe('milton')
    expect(voiceForBot(FACES[0], undefined, crew, VOICES, chosen)).toBe(DEALT[0])
  })

  it('there is no answer without voices, chosen or not', () => {
    expect(voicesForCrew([FACES[1]], [], chose([[FACES[1], ['aba']]])).size).toBe(0)
    expect(voiceForBot(FACES[1], 'aba', [FACES[1]], [], chose([[FACES[1], ['aba']]]))).toBeNull()
  })
})

describe('a voice this device doesn’t have falls back to Automatic', () => {
  it('the face is dealt as if it had chosen nothing, and nobody moves for it', () => {
    for (let n = 0; n < 300; n++) {
      const crew = shuffled(FACES).slice(0, 1 + Math.floor(random() * 10))
      const face = crew[Math.floor(random() * crew.length)]
      const want = Object.fromEntries(voicesForCrew(crew, VOICES))
      expect(Object.fromEntries(voicesForCrew(crew, VOICES, chose([[face, ['not-on-this-mac']]])))).toEqual(want)
    }
  })

  it('a voice the desktop lists elsewhere but this one doesn’t: Automatic here', () => {
    const fewer = VOICES.slice(0, 4)
    expect(fewer.some((v) => v.id === 'milton')).toBe(false)
    const crew = [FACES[0], FACES[1]]
    expect(voiceForBot(FACES[1], 'milton', crew, fewer, chose([[FACES[1], ['milton']]]))).toBe(voicesForCrew(crew, fewer).get(FACES[1]))
    expect(voiceForBot(FACES[1], 'milton', crew, fewer)).toBe(voiceForFace(FACES[1], crew, fewer))
  })
})

describe('the deal skips taken voices', () => {
  it('a face whose own voice a bot chose moves to the nearest free one', () => {
    // FACES[0]'s own voice is the first dealt; FACES[1]'s teammate chose it.
    const dealt = voicesForCrew([FACES[0], FACES[1]], VOICES, chose([[FACES[1], [DEALT[0]]]]))
    expect(dealt.get(FACES[1])).toBe(DEALT[0])
    expect(dealt.get(FACES[0])).toBe(DEALT[1])
    // Out of the crew, a face speaks in its own voice: the crew's choices don't move it.
    expect(voiceForFace(FACES[8], [FACES[1]], VOICES, chose([[FACES[1], [DEALT[0]]]]))).toBe(voiceForCharacter(FACES[8], VOICES))
  })

  it('every voice a face’s teammates chose is taken, not only the one it speaks in', () => {
    // FACES[2]'s teammates chose two voices; FACES[0] and FACES[1] would have them on their own.
    const dealt = voicesForCrew([FACES[0], FACES[1], FACES[2]], VOICES, chose([[FACES[2], [DEALT[0], DEALT[1]]]]))
    expect(dealt.get(FACES[2])).toBe(DEALT[0])
    expect(new Set(dealt.values()).size).toBe(3)
    expect([dealt.get(FACES[0]), dealt.get(FACES[1])]).not.toContain(DEALT[1])
  })

  it('while there are enough voices, no two bots share one unless they chose the same', () => {
    for (let n = 0; n < 2000; n++) {
      const count = 1 + Math.floor(random() * VOICES.length)
      const voices = VOICES.slice(0, count)
      const crew = shuffled(FACES).slice(0, 1 + Math.floor(random() * count))
      // Some of them chose a voice, each a different one.
      const picks = shuffled(voices.map((v) => v.id))
      const choosers = crew.filter(() => random() < 0.5)
      const chosen = chose(choosers.map((face, i) => [face, [picks[i]]]))
      const dealt = voicesForCrew(crew, voices, chosen)
      expect(dealt.size, crew.join(',')).toBe(crew.length)
      expect(new Set(dealt.values()).size, `${crew.join(',')} on ${count}`).toBe(crew.length)
      choosers.forEach((face, i) => expect(dealt.get(face)).toBe(picks[i]))
    }
  })

  it('two bots may choose the same voice; the rest keep clear of it', () => {
    const crew = [FACES[0], FACES[1], FACES[2], FACES[3]]
    const dealt = voicesForCrew(crew, VOICES, chose([
      [FACES[0], ['lori']],
      [FACES[3], ['lori']],
    ]))
    expect(dealt.get(FACES[0])).toBe('lori')
    expect(dealt.get(FACES[3])).toBe('lori')
    expect([dealt.get(FACES[1]), dealt.get(FACES[2])]).not.toContain('lori')
    expect(new Set([dealt.get(FACES[1]), dealt.get(FACES[2])]).size).toBe(2)
  })

  it('past that, they share as evenly as they can', () => {
    for (let n = 0; n < 500; n++) {
      const crew = shuffled(FACES).slice(0, VOICES.length + 1 + Math.floor(random() * 12))
      const picks = shuffled(VOICES.map((v) => v.id))
      const choosers = shuffled(crew).slice(0, Math.floor(random() * VOICES.length))
      const dealt = [...voicesForCrew(crew, VOICES, chose(choosers.map((face, i) => [face, [picks[i]]]))).values()]
      expect(dealt).toHaveLength(crew.length)
      const uses = VOICES.map((v) => dealt.filter((d) => d === v.id).length)
      expect(Math.max(...uses) - Math.min(...uses), `${crew.length} faces, ${choosers.length} chose`).toBeLessThanOrEqual(1)
    }
  })

  it('gives the same answer for the same crew and choices in any order', () => {
    for (let n = 0; n < 300; n++) {
      const crew = shuffled(FACES).slice(0, 1 + Math.floor(random() * 12))
      const chosen = chose(crew.filter(() => random() < 0.4).map((face) => [face, [VOICES[Math.floor(random() * VOICES.length)].id]]))
      const want = Object.fromEntries(voicesForCrew([...crew].sort(), VOICES, chosen))
      expect(Object.fromEntries(voicesForCrew(crew, VOICES, chosen))).toEqual(want)
      expect(Object.fromEntries(voicesForCrew([...crew].reverse(), VOICES, new Map([...chosen].reverse())))).toEqual(want)
    }
  })

  it('a choice for a face that isn’t on screen moves nobody', () => {
    const crew = [FACES[0], FACES[1]]
    expect(Object.fromEntries(voicesForCrew(crew, VOICES, chose([[FACES[5], [DEALT[0]]]])))).toEqual(Object.fromEntries(voicesForCrew(crew, VOICES)))
  })
})

describe('automaticVoice — what Automatic would give it', () => {
  it('leaves out the voice the bot chose itself', () => {
    const crew = [FACES[0], FACES[1], FACES[2]]
    const chosen = chose([[FACES[1], ['milton']]])
    expect(automaticVoice(FACES[1], VOICES, crew, chosen, 'milton')).toBe(voicesForCrew(crew, VOICES).get(FACES[1]))
  })

  it('keeps what another teammate on its face chose: the face speaks in that one', () => {
    const crew = [FACES[0], FACES[1]]
    expect(automaticVoice(FACES[1], VOICES, crew, chose([[FACES[1], ['milton', 'lori']]]), 'milton')).toBe('lori')
    // Two teammates on the face chose the same one: it stays theirs.
    expect(automaticVoice(FACES[1], VOICES, crew, chose([[FACES[1], ['lori', 'lori']]]), 'lori')).toBe('lori')
  })

  it('a face not on screen yet (a new bot) is dealt as if it had joined', () => {
    const crew = [FACES[0]]
    expect(automaticVoice(FACES[8], VOICES, crew)).toBe(voicesForCrew([FACES[0], FACES[8]], VOICES).get(FACES[8]))
    expect(automaticVoice(FACES[8], VOICES, crew)).not.toBe(voiceForCharacter(FACES[8], VOICES))
  })
})

describe('faceVoiceBesides — one face, one voice', () => {
  it('names the voice another teammate on the face chose, which an Automatic teammate on it speaks in', () => {
    const chosen = chose([[FACES[1], ['milton']]])
    expect(faceVoiceBesides(FACES[1], VOICES, chosen)).toBe('milton')
    expect(voiceForBot(FACES[1], null, [FACES[0], FACES[1]], VOICES, chosen)).toBe('milton')
    // Another face's choice is no business of this one.
    expect(faceVoiceBesides(FACES[2], VOICES, chosen)).toBeNull()
  })

  it('leaves out the teammate’s own choice (one entry of it), and any voice this device doesn’t have', () => {
    expect(faceVoiceBesides(FACES[1], VOICES, chose([[FACES[1], ['milton']]]), 'milton')).toBeNull()
    expect(faceVoiceBesides(FACES[1], VOICES, chose([[FACES[1], ['milton', 'milton']]]), 'milton')).toBe('milton')
    expect(faceVoiceBesides(FACES[1], VOICES, chose([[FACES[1], ['not-on-this-mac', 'lori']]]))).toBe('lori')
    expect(faceVoiceBesides(FACES[1], VOICES.slice(0, 2), chose([[FACES[1], ['lori']]]))).toBeNull()
    expect(faceVoiceBesides(FACES[1], [], chose([[FACES[1], ['lori']]]))).toBeNull()
  })

  it('agrees with what Automatic plays', () => {
    const crew = [FACES[0], FACES[1]]
    const chosen = chose([[FACES[1], ['lori', 'milton']]])
    expect(automaticVoice(FACES[1], VOICES, crew, chosen, 'lori')).toBe(faceVoiceBesides(FACES[1], VOICES, chosen, 'lori'))
  })
})

describe('chosenVoicesOf — the roster’s choices', () => {
  it('per face, in the roster’s order, one entry per teammate; nothing for no face, no voice or a bad one', () => {
    const chosen = chosenVoicesOf([
      { bot_character: FACES[0], voice: 'aba' },
      { bot_character: FACES[1], voice: null },
      { bot_character: FACES[0], voice: 'cha' },
      { bot_character: null, voice: 'ush' },
      { bot_character: 'not-a-character', voice: 'ush' },
      { bot_character: FACES[2], voice: 'Not A Voice' },
      { bot_character: FACES[3] },
      { bot_character: FACES[4], voice: 'lori' },
    ])
    expect([...chosen]).toEqual([
      [FACES[0], ['aba', 'cha']],
      [FACES[4], ['lori']],
    ])
  })
})

describe('setBotVoiceCrew — the choices handed over with the crew', () => {
  beforeEach(() => __resetBotVoicesForTests())

  it('keeps its own faces’ choices only, voice ids only; the same again is the same crew', () => {
    setBotVoiceCrew([FACES[2], FACES[9]], chose([
      [FACES[9], ['aba', 'Bad Id', 'cha']],
      [FACES[5], ['lori']],
      [FACES[2], []],
    ]))
    expect(readBotVoiceCrew()).toEqual([FACES[2], FACES[9]])
    expect([...readBotVoiceChoices()]).toEqual([[FACES[9], ['aba', 'cha']]])
    const held = { faces: readBotVoiceCrew(), chosen: readBotVoiceChoices() }
    setBotVoiceCrew([FACES[9], FACES[2]], chose([[FACES[9], ['aba', 'cha']]]))
    expect(readBotVoiceCrew()).toBe(held.faces)
    expect(readBotVoiceChoices()).toBe(held.chosen)
    // A choice changes: a new crew.
    setBotVoiceCrew([FACES[2], FACES[9]], chose([[FACES[9], ['lori']]]))
    expect([...readBotVoiceChoices()]).toEqual([[FACES[9], ['lori']]])
    // Nobody on screen: no choices either.
    setBotVoiceCrew([], chose([[FACES[9], ['lori']]]))
    expect(readBotVoiceCrew()).toEqual([])
    expect(readBotVoiceChoices().size).toBe(0)
  })
})
