/**
 * Each bot's speaking voice (bots-v2.md decision 8, Phase 4; bots-v4.md Phase
 * B2): every bot on screen speaks in a voice of its own, out of the TTS voices
 * the desktop has. A bot may have chosen one (`ai_team_member.voice`,
 * migration 308: picked in the one agent editor); otherwise it's Automatic,
 * dealt from its face.
 *
 * Pure answers. Each is deterministic for the same input, whatever order the
 * input comes in, so every window (each workspace window, and the main window
 * relaying the desktop overlay's bubble) works out the same voice for a bot
 * with nothing shared between them:
 *
 *   voiceForCharacter(face, voices)  the face on its own. The characters are
 *       taken in the catalogue's order (bot-characters.ts, where neighbours
 *       never share a hue) and dealt round the voices like cards: the
 *       desktop's default voice first, then the rest in the order it lists
 *       them. The first character speaks in the voice read-aloud uses by
 *       default. With eight voices, characters eight apart share one, so on
 *       its own this can put two bots on screen in the same voice.
 *       A bot built from parts (bot-parts.ts, an "x" id that is its recipe)
 *       isn't in the catalogue: its place in the deal is a stable hash of its
 *       id (FNV-1a), so built bots spread across the voices too, the same in
 *       every window, and no character's voice changes for them. Any other
 *       face (not a character, not a valid built id) speaks in the default
 *       voice.
 *
 *   voicesForCrew(crew, voices, chosen)  the faces in the user's crew
 *       together: the bots this user sees, the faces their AI teammates wear
 *       (AgentInfraHost's faces). A face stands for every teammate wearing it, and
 *       `chosen` holds, per face, the voices those teammates chose (their
 *       stored `voice`, in the roster's order: chosenVoicesOf).
 *         0. A face with a chosen voice this device has speaks in the first
 *            such, and every voice its teammates chose (that this device
 *            has) is taken: the deal below skips it while another is free.
 *            A chosen voice this device doesn't have counts for nothing: the
 *            face is dealt as if it had none (Automatic).
 *       The rest are dealt. A face's own voice is its voiceForCharacter
 *       answer.
 *         1. Going through the crew's characters in the catalogue's order,
 *            each face takes its own voice unless an earlier face already
 *            has it, or it's taken.
 *         2. Then each character left over, in the same order, takes the
 *            voice used least so far, the nearest to its own going round the
 *            dealing order.
 *       Then the crew's built bots, by id (the order inCrewOrder stands them
 *       in), the same two steps on the voices the characters left: each on its
 *       own voice if nobody has it yet, the rest on the least used.
 *       So no two faces in the crew share a voice while the crew has no more
 *       faces than there are voices, unless two bots chose the same one
 *       (allowed; the editor says who else uses it); past that, they share as
 *       evenly as they can (a voice is used twice only once every voice is
 *       used once).
 *       A character only ever leaves its own voice when an earlier character
 *       in the crew has the same one, or a bot chose it, so voices mostly stay
 *       put as teammates come and go.
 *       Two passes rather than one: in a single pass, a face pushed off its
 *       own voice could take a later face's own voice and push that one along
 *       too. A crew of every character, with nothing chosen, is the deal
 *       itself. The characters are dealt before any built bot, so a built bot
 *       joining or leaving never moves a character at all; a face neither a
 *       character nor a built bot isn't in the crew.
 *
 * voiceForFace(face, crew, voices, chosen) is the one a face speaks in: the
 * crew's answer for a face in it, else its own (a face outside the crew, or
 * before the crew is known). voiceForBot(face, own, …) is the one a teammate
 * speaks in: the voice it chose itself (`own`) when this device has it, else
 * its face's. One face speaks one voice: a teammate on Automatic that shares
 * its face with one that chose a voice speaks in that voice
 * (faceVoiceBesides). With no voices at all there is no answer (null), and
 * the desktop's own default speaks.
 *
 * Nothing names a character, a part or a voice here: the catalogue, the
 * built-bot id check and the desktop's list are read, so a new character,
 * part or voice simply takes its turn.
 *
 * The crew is this window's: AgentInfraHost hands its faces over, with the voices
 * its teammates chose off the roster (useBotVoiceCrew; empty until it has,
 * and once it's gone). `useBotVoice(face, own?)` asks the desktop for its
 * voices once per page (`tts_voices`; an empty answer is asked again next
 * time) and answers with that bot's voice in the crew, live: undefined while
 * it asks, null with none (and off the desktop). `own` is the teammate's own
 * choice, where whoever speaks knows which teammate it is (its page, the
 * bubble's teammate on show, the overlay's); without it, the face's. The
 * bubble's lines, its Read it, its chat's replies read aloud, the bot's page
 * and the desktop overlay's relay all take their voice from it, so a bot has
 * one voice wherever it speaks.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { BOT_CHARACTERS, isBuiltBotId } from '@/lib/bots/bot-faces'
import { isDesktopApp } from '@/lib/platform'
import { tauriBridge, type TtsVoice } from '@/lib/tauri-bridge'
import { asBotCharacter } from './teammate-faces'
import { asVoiceId, isVoiceId } from './voice-id'

type VoiceRef = Pick<TtsVoice, 'id' | 'default'>

/**
 * Per face, the voices its teammates chose (each one's stored `voice`, in the
 * roster's order, one entry per teammate): the first this device has is the
 * face's, and every one is taken from the deal.
 */
export type ChosenVoices = ReadonlyMap<string, readonly string[]>

const NONE_CHOSEN: ChosenVoices = new Map()
const NOBODY: readonly string[] = []

/** The voices in the order they're dealt: the default first, then the rest as listed. */
function dealingOrder(voices: readonly VoiceRef[]): string[] {
  const ids = voices.map((v) => v.id).filter((id, i, all) => !!id && all.indexOf(id) === i)
  const first = voices.find((v) => v.default && !!v.id)?.id ?? ids[0]
  return first ? [first, ...ids.filter((id) => id !== first)] : []
}

const CATALOGUE: ReadonlyMap<string, number> = new Map(BOT_CHARACTERS.map((c, index) => [c.type, index]))

/** A stable 32-bit hash of a string (FNV-1a): a built bot's place in the deal. */
function hashOf(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Where a face is dealt from: a character's place in the catalogue, a built
 * bot's hash (past the catalogue, so it never reads as a character's place),
 * or null for anything else.
 */
function dealtFrom(face: string): number | null {
  const index = CATALOGUE.get(face)
  if (index !== undefined) return index
  return isBuiltBotId(face) ? BOT_CHARACTERS.length + hashOf(face) : null
}

/**
 * The TTS voice a face speaks in on its own, out of `voices` (the desktop's
 * `tts_voices`): deterministic for a given list, neighbours in the
 * catalogue's order on different voices, a built bot on the voice its id
 * hashes to, the default voice for any other face, null when there are no
 * voices.
 */
export function voiceForCharacter(characterId: string, voices: readonly VoiceRef[]): string | null {
  const order = dealingOrder(voices)
  if (order.length === 0) return null
  const from = dealtFrom(characterId)
  return from === null ? order[0] : order[from % order.length]
}

/**
 * The crew's faces that have a place in the deal, each once, in the crew's
 * order (the characters in the catalogue's order, then built bots by id),
 * with where each is dealt from.
 */
function crewInOrder(crew: Iterable<string>): Array<{ face: string; index: number }> {
  const on = new Set(crew)
  const characters = BOT_CHARACTERS.flatMap((c, index) => (on.has(c.type) ? [{ face: c.type, index }] : []))
  const built = [...on]
    .filter((face) => !CATALOGUE.has(face) && isBuiltBotId(face))
    .sort()
    .map((face) => ({ face, index: dealtFrom(face) as number }))
  return [...characters, ...built]
}

/** The voices `face`'s teammates chose that this device has (`place`: the dealing order's), each once, the first one first. */
function chosenHere(face: string, chosen: ChosenVoices, place: ReadonlyMap<string, number>): string[] {
  return [...new Set((chosen.get(face) ?? []).filter((id) => place.has(id)))]
}

/**
 * Every crew face's voice, out of `voices` (the header's steps): a face whose
 * teammate chose a voice this device has speaks in it, and the rest are dealt
 * round what's left, no two on one while there are enough to go round, each
 * on its own (voiceForCharacter) unless an earlier face in the crew's order
 * has it or a bot chose it, the characters dealt before the built bots.
 * The same crew, choices and list give the same answer in any order; a face
 * that is neither a character nor a built bot isn't in it. Empty with no
 * voices.
 */
export function voicesForCrew(crew: Iterable<string>, voices: readonly VoiceRef[], chosen: ChosenVoices = NONE_CHOSEN): Map<string, string> {
  const order = dealingOrder(voices)
  const out = new Map<string, string>()
  const count = order.length
  if (count === 0) return out
  const place = new Map(order.map((id, i) => [id, i]))
  const uses = new Array<number>(count).fill(0)
  // 0. A face whose teammate chose a voice this device has speaks in it, and
  // every voice they chose is taken; the rest are dealt.
  const dealt: Array<{ face: string; index: number }> = []
  for (const member of crewInOrder(crew)) {
    const mine = chosenHere(member.face, chosen, place)
    if (mine.length === 0) {
      dealt.push(member)
      continue
    }
    out.set(member.face, mine[0])
    for (const id of mine) uses[place.get(id) as number]++
  }
  // The characters first, then the built bots on what's left: a built bot never moves a character.
  const deal = (group: Array<{ face: string; index: number }>) => {
    const left: Array<{ face: string; own: number }> = []
    // 1. Each face on its own voice, unless an earlier face has it, or a bot chose it.
    for (const { face, index } of group) {
      const own = index % count
      if (uses[own] === 0) {
        uses[own] = 1
        out.set(face, order[own])
      } else {
        left.push({ face, own })
      }
    }
    // 2. Each face left over on the voice used least so far, the nearest to its own going round.
    for (const { face, own } of left) {
      let pick = own
      for (let step = 1; step < count; step++) {
        const at = (own + step) % count
        if (uses[at] < uses[pick]) pick = at
      }
      uses[pick]++
      out.set(face, order[pick])
    }
  }
  deal(dealt.filter((f) => f.index < BOT_CHARACTERS.length))
  deal(dealt.filter((f) => f.index >= BOT_CHARACTERS.length))
  return out
}

/**
 * The voice a face speaks in, given its crew (the faces on screen), what its
 * teammates chose and `voices`: the crew's answer for a face in it
 * (voicesForCrew), else the first voice its teammates chose that this device
 * has, else its own (voiceForCharacter). Null when there are no voices.
 */
export function voiceForFace(face: string, crew: Iterable<string>, voices: readonly VoiceRef[], chosen: ChosenVoices = NONE_CHOSEN): string | null {
  const inCrew = voicesForCrew(crew, voices, chosen).get(face)
  if (inCrew) return inCrew
  const place = new Map(dealingOrder(voices).map((id, i) => [id, i]))
  return chosenHere(face, chosen, place)[0] ?? voiceForCharacter(face, voices)
}

/**
 * The voice a teammate speaks in: the one it chose itself (`own`, its stored
 * `voice`) when this device has it, else its face's (voiceForFace: a voice
 * this device doesn't have falls back to Automatic). Null when there are no
 * voices.
 */
export function voiceForBot(
  face: string,
  own: string | null | undefined,
  crew: Iterable<string>,
  voices: readonly VoiceRef[],
  chosen: ChosenVoices = NONE_CHOSEN,
): string | null {
  if (own && voices.some((v) => v.id === own)) return own
  return voiceForFace(face, crew, voices, chosen)
}

/** `chosen` less one entry of `own` on `face`: what the face's other teammates chose. */
function withoutOwnChoice(chosen: ChosenVoices, face: string, own: string | null): ChosenVoices {
  const list = chosen.get(face)
  if (!own || !list?.includes(own)) return chosen
  const left = [...list]
  left.splice(left.indexOf(own), 1)
  const next = new Map(chosen)
  if (left.length > 0) next.set(face, left)
  else next.delete(face)
  return next
}

/**
 * The voice a teammate on `face` speaks in on Automatic, in this crew: its
 * face's (voiceForFace, the face joining the crew if it isn't in it), without
 * the voice it chose itself (`own`, one of its face's entries in `chosen`).
 * One face speaks one voice, so when another teammate on that face chose one
 * this device has, that's it (faceVoiceBesides). What the editor's Automatic
 * plays before it's saved.
 */
export function automaticVoice(
  face: string,
  voices: readonly VoiceRef[],
  crew: Iterable<string> = NOBODY,
  chosen: ChosenVoices = NONE_CHOSEN,
  own: string | null = null,
): string | null {
  return voiceForFace(face, [...crew, face], voices, withoutOwnChoice(chosen, face, own))
}

/**
 * The voice another teammate on `face` chose, the first this device has in
 * the roster's order, leaving out one entry of `own` (the voice this teammate
 * chose itself); null when none did. A teammate on Automatic sharing a face
 * with one that chose a voice speaks in that voice: one face, one voice.
 */
export function faceVoiceBesides(
  face: string,
  voices: readonly VoiceRef[],
  chosen: ChosenVoices = NONE_CHOSEN,
  own: string | null = null,
): string | null {
  const place = new Map(dealingOrder(voices).map((id, i) => [id, i]))
  return chosenHere(face, withoutOwnChoice(chosen, face, own), place)[0] ?? null
}

/**
 * Per face, the voices the teammates wearing it chose: each one's stored
 * `voice`, in the roster's order (oldest first, then by id: the same in every
 * window), one entry per teammate. A teammate with no face, or on Automatic,
 * adds nothing.
 */
export function chosenVoicesOf(roster: ReadonlyArray<{ bot_character?: unknown; voice?: unknown }>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const mate of roster) {
    const face = asBotCharacter(mate.bot_character)
    const voice = asVoiceId(mate.voice)
    if (!face || !voice) continue
    const list = out.get(face)
    if (list) list.push(voice)
    else out.set(face, [voice])
  }
  return out
}

// ── This window's crew ──

interface Crew {
  /** The faces on screen, in the crew's order, each once. */
  faces: readonly string[]
  /** What their teammates chose, for the crew's faces only. */
  chosen: ChosenVoices
  /** Both, as one string: nothing happens when it hasn't changed. */
  key: string
}

const NO_CREW: Crew = { faces: NOBODY, chosen: NONE_CHOSEN, key: '' }
let crewNow: Crew = NO_CREW
const crewListeners = new Set<() => void>()

const byFace = ([a]: [string, readonly string[]], [b]: [string, readonly string[]]) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * This window's crew is `faces` (the bots on screen), with the voices their
 * teammates chose (`chosen`): what every voice here is worked out against.
 * Kept in the crew's order (characters, then built bots by id), each once,
 * with the choices of its own faces only, voice ids only; nothing happens when
 * that hasn't changed.
 */
export function setBotVoiceCrew(faces: Iterable<string>, chosen?: ChosenVoices): void {
  const next = crewInOrder(faces).map((m) => m.face)
  const on = new Set(next)
  const kept: Array<[string, string[]]> = []
  for (const [face, ids] of chosen ?? NONE_CHOSEN) {
    if (!on.has(face)) continue
    const list = ids.filter(isVoiceId)
    if (list.length > 0) kept.push([face, list])
  }
  kept.sort(byFace)
  const key = next.length > 0 ? JSON.stringify([next, kept]) : ''
  if (key === crewNow.key) return
  crewNow = key ? { faces: next, chosen: new Map(kept), key } : NO_CREW
  for (const listener of [...crewListeners]) listener()
}

/** This window's crew, as last handed over (empty until it has been). */
export function readBotVoiceCrew(): readonly string[] {
  return crewNow.faces
}

/** The voices this window's crew's teammates chose, as last handed over (none until then). */
export function readBotVoiceChoices(): ChosenVoices {
  return crewNow.chosen
}

function readCrew(): Crew {
  return crewNow
}

function subscribeCrew(listener: () => void): () => void {
  crewListeners.add(listener)
  return () => {
    crewListeners.delete(listener)
  }
}

const noCrew = () => NO_CREW

/** This window's crew, live (the editor's Automatic works out against it). */
export function useBotVoiceCrewNow(): { faces: readonly string[]; chosen: ChosenVoices } {
  return useSyncExternalStore(subscribeCrew, readCrew, noCrew)
}

/**
 * The crew's side of useBotVoice (AgentInfraHost, once per window): `faces`,
 * the faces the reachable teammates wear, with the voices their teammates chose (`chosen`,
 * chosenVoicesOf the roster), are this window's crew while it's mounted, and
 * nobody once it's gone.
 */
export function useBotVoiceCrew(faces: readonly string[], chosen?: ChosenVoices): void {
  const key = faces.join(',')
  const choices = chosen && chosen.size > 0 ? JSON.stringify([...chosen].sort(byFace)) : ''
  useLayoutEffect(() => {
    setBotVoiceCrew(key ? key.split(',') : NOBODY, choices ? new Map(JSON.parse(choices) as Array<[string, string[]]>) : undefined)
  }, [key, choices])
  useLayoutEffect(() => () => setBotVoiceCrew(NOBODY), [])
}

// ── The desktop's voices ──

let voicesAsked: Promise<TtsVoice[]> | null = null
let voicesKnown: TtsVoice[] | null = null

/** The desktop's voices, asked once per page (an empty or failed answer is asked again next time). */
export function loadBotVoices(): Promise<TtsVoice[]> {
  if (!voicesAsked) {
    voicesAsked = tauriBridge
      .ttsVoices()
      .catch(() => [] as TtsVoice[])
      .then((voices) => {
        if (voices.length === 0) voicesAsked = null
        else voicesKnown = voices
        return voices
      })
  }
  return voicesAsked
}

/**
 * The desktop's voices, live: undefined while it's still being asked, null
 * when it has none to give (and always off the desktop: the browser has no
 * voices).
 */
export function useDeviceVoices(): TtsVoice[] | null | undefined {
  const [voices, setVoices] = useState<TtsVoice[] | null>(voicesKnown)
  const [asked, setAsked] = useState(voicesKnown !== null)
  const desktop = isDesktopApp()
  useEffect(() => {
    if (voices || !desktop) return
    let live = true
    void loadBotVoices().then((list) => {
      if (!live) return
      if (list.length > 0) setVoices(list)
      setAsked(true)
    })
    return () => {
      live = false
    }
  }, [voices, desktop])
  if (!desktop) return null
  if (voices) return voices
  return asked ? null : undefined
}

/**
 * A bot's voice in this window's crew, live: the one its teammate chose
 * (`own`, when whoever speaks knows which teammate it is) if this device has
 * it, else its face's (voiceForBot). Undefined while the desktop is still
 * being asked, null when it has none to give (and always off the desktop), so
 * whoever speaks can wait for the bot's own voice rather than start in
 * another.
 */
export function useBotVoice(face: string, own?: string | null): string | null | undefined {
  const voices = useDeviceVoices()
  const crew = useSyncExternalStore(subscribeCrew, readCrew, noCrew)
  if (!voices) return voices
  return voiceForBot(face, own, crew.faces, voices, crew.chosen)
}

/** Tests only: forget the desktop's voices and the crew. */
export function __resetBotVoicesForTests(): void {
  voicesAsked = null
  voicesKnown = null
  crewNow = NO_CREW
}
