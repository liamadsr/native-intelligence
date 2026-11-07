/**
 * The bots' voices (bots-v2.md decision 8, Phase 4; lib/bots/bot-voice.ts).
 *
 * voiceForCharacter, a face on its own, dealt from the catalogue:
 *   • deterministic: the same list in the same order, the same answer;
 *   • spread: neighbours in the catalogue's order never share a voice when
 *     there are two or more, and every voice is used;
 *   • the first character speaks in the catalogue's default voice, wherever
 *     the desktop lists it;
 *   • fallback: a face the catalogue doesn't know speaks in the default voice
 *     (the first listed when none is marked); no voices, no answer.
 *
 * voicesForCrew / voiceForFace, the faces on screen together:
 *   • unique: no two faces in a crew of one to eight share a voice (every
 *     crew of up to four, a seeded sample past that, faces that shared one
 *     on their own included), nor with fewer voices while the crew fits;
 *   • own voice: a face keeps its voiceForCharacter answer unless an earlier
 *     face in the crew has the same one;
 *   • stable: adding a face moves nobody who keeps their own voice, including
 *     a later face that a pushed-along one would have bumped in a single pass;
 *   • spread: a crew bigger than the voices shares them as evenly as it can,
 *     and a crew of every character is the deal itself;
 *   • deterministic: the same crew in any order (or repeated) gives the same
 *     answer;
 *   • fallback: a face outside the crew (or with no crew) speaks in its own
 *     voice; no voices, no answer;
 *   • the crew handed over (setBotVoiceCrew): the catalogue's order, each
 *     once, faces the catalogue doesn't know left out.
 *
 * Built bots (bot-parts.ts: an "x" id that is its recipe), off the catalogue:
 *   • each has a voice of its own, deterministic, dealt from a hash of its id,
 *     so many built bots spread over every voice; an id that isn't a valid
 *     built bot's speaks in the default voice;
 *   • they join the crew after every character (by id), so no two bots in a
 *     mixed crew share a voice while it fits, the answer doesn't depend on
 *     the crew's order, and a character keeps the voice it had without them.
 *
 * No character is named: faces are read off the catalogue by position. The
 * voices are a list shaped like the desktop's (eight, the default partway
 * down); the crew's tests read them off it too.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { BOT_CHARACTERS, BUILT_BODIES, BUILT_COLORS, BUILT_GLASSES, builtBotId, isBuiltBotId } from '@/lib/bots/bot-faces'
import {
  __resetBotVoicesForTests,
  readBotVoiceCrew,
  setBotVoiceCrew,
  voiceForCharacter,
  voiceForFace,
  voicesForCrew,
} from '../bot-voice'

const voice = (id: string, isDefault = false) => ({ id, name: id, description: '', default: isDefault })
/** Shaped like the desktop's catalogue: eight voices, the default one partway down. */
const VOICES = ['aba', 'cha', 'ush', 'chichi', 'lori', 'lowli', 'tana', 'milton'].map((id) => voice(id, id === 'tana'))
const FACES: readonly string[] = BOT_CHARACTERS.map((c) => c.type)
/** The voices in dealing order: the default first, then the rest as listed. */
const DEALT = [...VOICES.filter((v) => v.default), ...VOICES.filter((v) => !v.default)].map((v) => v.id)

describe('voiceForCharacter', () => {
  it('is deterministic for a given list', () => {
    const first = FACES.map((f) => voiceForCharacter(f, VOICES))
    const again = FACES.map((f) => voiceForCharacter(f, [...VOICES]))
    expect(again).toEqual(first)
    expect(first.every((v) => typeof v === 'string')).toBe(true)
  })

  it('spreads neighbours in the crew across voices, and uses every voice', () => {
    for (const count of [2, 3, 5, 8]) {
      const voices = VOICES.slice(0, count)
      const dealt = FACES.map((f) => voiceForCharacter(f, voices))
      for (let i = 1; i < dealt.length; i++) expect(dealt[i], `${FACES[i - 1]} / ${FACES[i]} with ${count}`).not.toBe(dealt[i - 1])
      expect(new Set(dealt).size).toBe(count)
    }
  })

  it('shares voices as evenly as it can when there are fewer voices than characters', () => {
    const dealt = FACES.map((f) => voiceForCharacter(f, VOICES))
    const uses = [...new Set(dealt)].map((v) => dealt.filter((d) => d === v).length)
    expect(Math.max(...uses) - Math.min(...uses)).toBeLessThanOrEqual(1)
  })

  it('gives the first character the default voice, wherever it is listed', () => {
    expect(voiceForCharacter(FACES[0], VOICES)).toBe('tana')
    expect(voiceForCharacter(FACES[1], VOICES)).toBe('aba')
  })

  it('falls back to the default voice for a face the catalogue does not know', () => {
    expect(voiceForCharacter('not-a-character', VOICES)).toBe('tana')
    // None marked default: the first listed.
    expect(voiceForCharacter('not-a-character', [voice('x'), voice('y')])).toBe('x')
  })

  it('has no answer without voices (the desktop default speaks)', () => {
    expect(voiceForCharacter(FACES[0], [])).toBeNull()
  })

  it('ignores a duplicate or empty id', () => {
    const dealt = FACES.slice(0, 4).map((f) => voiceForCharacter(f, [voice('a', true), voice(''), voice('b'), voice('a')]))
    expect(dealt).toEqual(['a', 'b', 'a', 'b'])
  })
})

// ── The crew ──

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
const random = seeded(8)
/** `size` faces, picked at random, in a random order. */
function someCrew(size: number, from: readonly string[] = FACES): string[] {
  const pool = [...from]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, size)
}
/** Every crew of `size` faces. */
function* everyCrew(size: number, start = 0, chosen: string[] = []): Generator<string[]> {
  if (chosen.length === size) {
    yield chosen
    return
  }
  for (let i = start; i <= FACES.length - (size - chosen.length); i++) yield* everyCrew(size, i + 1, [...chosen, FACES[i]])
}
const catalogueIndex = (face: string) => FACES.indexOf(face)
/** The faces that share `face`'s own voice and come before it in the catalogue's order. */
const earlierOnTheSameVoice = (face: string, crew: readonly string[], count: number) =>
  crew.filter((other) => catalogueIndex(other) < catalogueIndex(face) && catalogueIndex(other) % count === catalogueIndex(face) % count)

function expectUnique(crew: readonly string[], voices = VOICES) {
  const dealt = voicesForCrew(crew, voices)
  expect([...dealt.keys()].sort(), crew.join(',')).toEqual([...crew].sort())
  expect(new Set(dealt.values()).size, crew.join(',')).toBe(crew.length)
}

describe('voicesForCrew — no two bots on screen in the same voice', () => {
  it('parts two faces that shared a voice on their own (catalogue 0 and 8): the first keeps it, the other takes the next', () => {
    expect(voiceForCharacter(FACES[0], VOICES)).toBe(voiceForCharacter(FACES[8], VOICES))
    const dealt = voicesForCrew([FACES[8], FACES[0]], VOICES)
    expect(dealt.get(FACES[0])).toBe(DEALT[0])
    expect(dealt.get(FACES[8])).toBe(DEALT[1])
    // Three on the same voice on their own: three voices.
    expectUnique([FACES[16], FACES[8], FACES[0]])
  })

  it('moves a pushed face to the nearest free voice after its own, going round the dealing order', () => {
    // Catalogue 1 and 9 share the second voice: 9 takes the third, not the first.
    expect(voicesForCrew([FACES[1], FACES[9]], VOICES).get(FACES[9])).toBe(DEALT[2])
    // Catalogue 7 and 15 share the last voice: 15 goes round to the first.
    expect(voicesForCrew([FACES[7], FACES[15]], VOICES).get(FACES[15])).toBe(DEALT[0])
    // The next one along taken too: the one after it.
    expect(voicesForCrew([FACES[7], FACES[15], FACES[0]], VOICES).get(FACES[15])).toBe(DEALT[1])
  })

  it('gives every face its own voice in every crew of one to four', () => {
    let crews = 0
    for (let size = 1; size <= 4; size++) {
      for (const crew of everyCrew(size)) {
        const dealt = voicesForCrew(crew, VOICES)
        if (new Set(dealt.values()).size !== size || dealt.size !== size) expectUnique(crew)
        crews++
      }
    }
    expect(crews).toBe(24 + 276 + 2024 + 10626)
  })

  it('and in a sample of crews of five to eight, the ones packed onto shared voices among them', () => {
    for (let size = 5; size <= 8; size++) {
      for (let n = 0; n < 1500; n++) expectUnique(someCrew(size))
      // Packed: as many faces as possible on as few voices on their own (the catalogue's columns of eight).
      const packed = FACES.filter((_, i) => i % 8 < Math.ceil(size / 3)).slice(0, size)
      expectUnique(packed)
    }
  })

  it('with fewer voices, still none shared while the crew fits, and every voice in use when it fills them', () => {
    for (let count = 1; count <= VOICES.length; count++) {
      const voices = VOICES.slice(0, count)
      for (let n = 0; n < 300; n++) {
        const size = 1 + Math.floor(random() * count)
        expectUnique(someCrew(size), voices)
      }
      const full = voicesForCrew(someCrew(count), voices)
      expect(new Set(full.values())).toEqual(new Set(voices.map((v) => v.id)))
    }
  })
})

describe('voicesForCrew — voices stay put', () => {
  it('keeps a face on its own voice unless an earlier face in the crew has the same one', () => {
    for (let n = 0; n < 2000; n++) {
      const crew = someCrew(1 + Math.floor(random() * 8))
      const dealt = voicesForCrew(crew, VOICES)
      for (const face of crew) {
        if (earlierOnTheSameVoice(face, crew, VOICES.length).length === 0) {
          expect(dealt.get(face), `${face} in ${crew.join(',')}`).toBe(voiceForCharacter(face, VOICES))
        } else {
          expect(dealt.get(face), `${face} in ${crew.join(',')}`).not.toBe(voiceForCharacter(face, VOICES))
        }
      }
    }
  })

  it('moves nobody who keeps their own voice when a face joins', () => {
    for (let n = 0; n < 2000; n++) {
      const crew = someCrew(1 + Math.floor(random() * 7))
      const joining = someCrew(1, FACES.filter((f) => !crew.includes(f)))[0]
      const before = voicesForCrew(crew, VOICES)
      const after = voicesForCrew([...crew, joining], VOICES)
      for (const face of crew) {
        // Nobody else in the bigger crew wants its own voice: it hasn't moved.
        const contested = [...crew, joining].some((o) => o !== face && catalogueIndex(o) % VOICES.length === catalogueIndex(face) % VOICES.length)
        if (!contested) expect(after.get(face), `${face}: ${crew.join(',')} + ${joining}`).toBe(before.get(face))
        // On its own voice before, and the newcomer isn't ahead of it on that voice: still there.
        const ownBefore = before.get(face) === voiceForCharacter(face, VOICES)
        const pushedBy = earlierOnTheSameVoice(face, [joining], VOICES.length).length > 0
        if (ownBefore && !pushedBy) expect(after.get(face), `${face}: ${crew.join(',')} + ${joining}`).toBe(before.get(face))
      }
    }
  })

  it('never lets a face pushed off its own voice push a later face off its own (two passes, not one)', () => {
    // Catalogue 0 and 9 on their own voices; 8 joins, wanting 0's. In a single
    // pass 8 would take the next voice, 9's own, and push 9 along too.
    const before = voicesForCrew([FACES[0], FACES[9]], VOICES)
    const after = voicesForCrew([FACES[0], FACES[9], FACES[8]], VOICES)
    expect(after.get(FACES[0])).toBe(before.get(FACES[0]))
    expect(after.get(FACES[9])).toBe(before.get(FACES[9]))
    expect(after.get(FACES[9])).toBe(voiceForCharacter(FACES[9], VOICES))
    expect(after.get(FACES[8])).toBe(DEALT[2])
  })
})

describe('voicesForCrew — more faces than voices', () => {
  it('shares them as evenly as it can: a voice used twice only once every voice is used', () => {
    for (let n = 0; n < 1000; n++) {
      const count = 1 + Math.floor(random() * VOICES.length)
      const voices = VOICES.slice(0, count)
      const crew = someCrew(1 + Math.floor(random() * FACES.length))
      const dealt = [...voicesForCrew(crew, voices).values()]
      expect(dealt).toHaveLength(crew.length)
      const uses = voices.map((v) => dealt.filter((d) => d === v.id).length)
      expect(Math.max(...uses) - Math.min(...uses), `${crew.length} on ${count}`).toBeLessThanOrEqual(1)
    }
    const twelve = [...voicesForCrew(FACES.slice(0, 12), VOICES).values()]
    expect(new Set(twelve).size).toBe(VOICES.length)
  })

  it('is the deal itself for a crew of every character', () => {
    for (let count = 1; count <= VOICES.length; count++) {
      const voices = VOICES.slice(0, count)
      const dealt = voicesForCrew(FACES, voices)
      expect(FACES.map((f) => dealt.get(f))).toEqual(FACES.map((f) => voiceForCharacter(f, voices)))
    }
  })
})

describe('voicesForCrew — the same crew, the same voices', () => {
  it('gives the same answer for the same crew in any order, repeated or not', () => {
    for (let n = 0; n < 500; n++) {
      const crew = someCrew(1 + Math.floor(random() * FACES.length))
      const sorted = [...crew].sort((a, b) => catalogueIndex(a) - catalogueIndex(b))
      const want = Object.fromEntries(voicesForCrew(sorted, VOICES))
      expect(Object.fromEntries(voicesForCrew(crew, VOICES))).toEqual(want)
      expect(Object.fromEntries(voicesForCrew([...crew].reverse(), VOICES))).toEqual(want)
      expect(Object.fromEntries(voicesForCrew([...crew, ...crew], VOICES))).toEqual(want)
      expect(Object.fromEntries(voicesForCrew(new Set(crew), VOICES))).toEqual(want)
    }
  })
})

describe('voiceForFace — falling back', () => {
  it('speaks in the crew’s voice for a face in it, and its own for a face outside it', () => {
    const crew = [FACES[0], FACES[8]]
    expect(voiceForFace(FACES[8], crew, VOICES)).toBe(DEALT[1])
    // Outside the crew: its own, even where that's a crew face's voice.
    expect(voiceForFace(FACES[16], crew, VOICES)).toBe(voiceForCharacter(FACES[16], VOICES))
    expect(voiceForFace(FACES[3], crew, VOICES)).toBe(voiceForCharacter(FACES[3], VOICES))
  })

  it('speaks in its own voice before the crew is known', () => {
    for (const face of FACES) expect(voiceForFace(face, [], VOICES)).toBe(voiceForCharacter(face, VOICES))
  })

  it('leaves a face the catalogue doesn’t know out of the crew: it speaks in the default voice', () => {
    const dealt = voicesForCrew(['not-a-character', FACES[0]], VOICES)
    expect([...dealt.keys()]).toEqual([FACES[0]])
    expect(voiceForFace('not-a-character', ['not-a-character', FACES[0]], VOICES)).toBe(DEALT[0])
  })

  it('has no answer without voices, in the crew or out of it', () => {
    expect(voicesForCrew([FACES[0], FACES[8]], []).size).toBe(0)
    expect(voiceForFace(FACES[8], [FACES[0], FACES[8]], [])).toBeNull()
    expect(voiceForFace(FACES[3], [FACES[0]], [])).toBeNull()
  })
})

describe('setBotVoiceCrew — the crew handed over', () => {
  beforeEach(() => __resetBotVoicesForTests())

  it('keeps it in the catalogue’s order, each once, without faces the catalogue doesn’t know', () => {
    expect(readBotVoiceCrew()).toEqual([])
    setBotVoiceCrew([FACES[9], 'not-a-character', FACES[2], FACES[9]])
    expect(readBotVoiceCrew()).toEqual([FACES[2], FACES[9]])
    // The same crew again: the same array (nothing to re-render).
    const held = readBotVoiceCrew()
    setBotVoiceCrew([FACES[2], FACES[9]])
    expect(readBotVoiceCrew()).toBe(held)
    setBotVoiceCrew([])
    expect(readBotVoiceCrew()).toEqual([])
  })
})

// ── Built bots ──

/** Built bots made from the part lists by position (no part named): one per body, colour and glasses mix. */
const BUILT: readonly string[] = BUILT_BODIES.flatMap((body, i) =>
  [undefined, ...BUILT_GLASSES.slice(0, 2)].map((glasses, j) => {
    const id = builtBotId({ body, color: BUILT_COLORS[(i + j) % BUILT_COLORS.length], glasses })
    if (!id) throw new Error(`no id for ${body}`)
    return id
  }),
)

describe('built bots — a voice of their own', () => {
  it('are valid built ids, all different, none a character', () => {
    expect(BUILT.every((id) => isBuiltBotId(id))).toBe(true)
    expect(new Set(BUILT).size).toBe(BUILT.length)
    expect(BUILT.some((id) => FACES.includes(id))).toBe(false)
  })

  it('each speak in a deterministic voice, and together they use every voice', () => {
    for (const count of [2, 3, 5, 8]) {
      const voices = VOICES.slice(0, count)
      const dealt = BUILT.map((id) => voiceForCharacter(id, voices))
      expect(BUILT.map((id) => voiceForCharacter(id, [...voices]))).toEqual(dealt)
      expect(dealt.every((v) => voices.some((voice) => voice.id === v))).toBe(true)
      expect(new Set(dealt).size, `${count} voices`).toBe(count)
    }
  })

  it('do not all fall back to the default voice', () => {
    const own = BUILT.map((id) => voiceForCharacter(id, VOICES))
    expect(own.filter((v) => v === DEALT[0]).length).toBeLessThan(BUILT.length / 2)
  })

  it('an id that looks built but is not a valid recipe speaks in the default voice, and stays out of the crew', () => {
    const bogus = 'xzzzzzzz'
    expect(isBuiltBotId(bogus)).toBe(false)
    expect(voiceForCharacter(bogus, VOICES)).toBe(DEALT[0])
    expect([...voicesForCrew([bogus, FACES[3]], VOICES).keys()]).toEqual([FACES[3]])
  })

  it('leave every character on its own voice (the catalogue deal is unchanged)', () => {
    for (let count = 1; count <= VOICES.length; count++) {
      const voices = VOICES.slice(0, count)
      const dealt = [...voices.filter((v) => v.default), ...voices.filter((v) => !v.default)].map((v) => v.id)
      FACES.forEach((face, i) => expect(voiceForCharacter(face, voices)).toBe(dealt[i % count]))
    }
  })
})

describe('built bots — in the crew', () => {
  /** A crew of characters and built bots, `size` in all, in a random order. */
  function mixedCrew(size: number): string[] {
    const builtCount = Math.floor(random() * (size + 1))
    return someCrew(size, [...someCrew(size - builtCount), ...someCrew(builtCount, BUILT)])
  }

  it('gives every face its own voice while the crew fits, built bots included', () => {
    for (let count = 1; count <= VOICES.length; count++) {
      const voices = VOICES.slice(0, count)
      for (let n = 0; n < 400; n++) expectUnique(mixedCrew(1 + Math.floor(random() * count)), voices)
    }
    // A crew of built bots only, as many as there are voices.
    for (let n = 0; n < 400; n++) expectUnique(someCrew(VOICES.length, BUILT))
  })

  it('shares as evenly as it can past that', () => {
    for (let n = 0; n < 300; n++) {
      const crew = mixedCrew(VOICES.length + 1 + Math.floor(random() * 20))
      const dealt = [...voicesForCrew(crew, VOICES).values()]
      expect(dealt).toHaveLength(crew.length)
      const uses = VOICES.map((v) => dealt.filter((d) => d === v.id).length)
      expect(Math.max(...uses) - Math.min(...uses)).toBeLessThanOrEqual(1)
    }
  })

  it('gives the same answer for the same crew in any order, repeated or not', () => {
    for (let n = 0; n < 300; n++) {
      const crew = mixedCrew(1 + Math.floor(random() * 12))
      const want = Object.fromEntries(voicesForCrew([...crew].sort(), VOICES))
      expect(Object.fromEntries(voicesForCrew(crew, VOICES))).toEqual(want)
      expect(Object.fromEntries(voicesForCrew([...crew].reverse(), VOICES))).toEqual(want)
      expect(Object.fromEntries(voicesForCrew([...crew, ...crew], VOICES))).toEqual(want)
    }
  })

  it('never moves a character when built bots join', () => {
    for (let n = 0; n < 1000; n++) {
      const crew = someCrew(1 + Math.floor(random() * 7))
      const joining = someCrew(1 + Math.floor(random() * 3), BUILT)
      const before = voicesForCrew(crew, VOICES)
      const after = voicesForCrew([...joining, ...crew], VOICES)
      for (const face of crew) expect(after.get(face), `${face}: ${crew.join(',')} + ${joining.join(',')}`).toBe(before.get(face))
    }
  })

  it('keeps a built bot on its own voice when nobody ahead of it wants that one', () => {
    const id = BUILT[5]
    const own = voiceForCharacter(id, VOICES)
    expect(voicesForCrew([id], VOICES).get(id)).toBe(own)
    expect(voiceForFace(id, [], VOICES)).toBe(own)
    // A character on the same voice comes first: the built bot moves, the character doesn't.
    const rival = FACES.find((f) => voiceForCharacter(f, VOICES) === own) as string
    const dealt = voicesForCrew([id, rival], VOICES)
    expect(dealt.get(rival)).toBe(own)
    expect(dealt.get(id)).not.toBe(own)
  })

  it('hands built bots over in the crew after the characters, by id', () => {
    __resetBotVoicesForTests()
    const [a, b] = [...BUILT.slice(0, 2)].sort()
    setBotVoiceCrew([b, FACES[9], a, 'not-a-character', FACES[2], b])
    expect(readBotVoiceCrew()).toEqual([FACES[2], FACES[9], a, b])
    __resetBotVoicesForTests()
  })
})
