// The reference blueprint's pure parts (blueprint.ts keeps it, engine/blueprint.ts builds the beat grid). A blueprint
// is what a reference video teaches about structure: where it cuts, how long each beat runs, how fast the person
// talks, how busy the picture is. It borrows rhythm and structure, never the reference's words, brand or footage, so
// the storyboard lines made from it carry the person's own words or none, and shot notes that name the reference's
// times, never what it said.
//
//   engineReview     a review job's answer (its scene list) in the shape the engine's makeBlueprint reads
//   buildBlueprint   the review and the reference's timed words, as the engine's blueprint
//   blueprintLines   storyboard_from_script lines in the blueprint's rhythm, scaled to a length, with the person's lines
import { makeBlueprint, type Blueprint, type ReviewResult as EngineReview, type TimedWord } from '../engine/blueprint'
import { WORDS_PER_SECOND, wordCount, type BeatSource } from '../engine/storyboard'
import type { ReviewResult, ReviewScene, ReviewShot } from './check-contract'

/** A finite number, or undefined. Pure. */
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Rounded to `d` decimals. Pure. */
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

/** Seconds as m:ss. Pure. */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const SHOTS: readonly ReviewShot[] = ['text', 'talk', 'motion', 'still', 'empty']

/**
 * A worker's scene list, checked (the worker is trusted only so far): a scene needs a whole index and finite times
 * in order; how it reads is one of the known kinds (else a still), its counts are numbers and its on-screen text a
 * list of strings. Anything else is dropped, so no words reach a storyboard's shot notes or the agent where a kind or
 * a count belongs. Pure.
 */
export function checkedScenes(list: unknown): ReviewScene[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((value): ReviewScene[] => {
    if (!value || typeof value !== 'object') return []
    const s = value as Record<string, unknown>
    const start = num(s.start)
    const end = num(s.end)
    if (!Number.isInteger(s.index) || (s.index as number) < 0 || start === undefined || end === undefined || start < 0 || end < start) return []
    const onScreen = Array.isArray(s.onScreen) ? s.onScreen.filter((line): line is string => typeof line === 'string') : undefined
    const count = num(s.wordsOnScreen)
    return [{
      index: s.index as number,
      start,
      end,
      seconds: num(s.seconds) ?? end - start,
      shot: SHOTS.includes(s.shot as ReviewShot) ? (s.shot as ReviewShot) : 'still',
      entersBy: typeof s.entersBy === 'string' ? s.entersBy.slice(0, 40) : 'cut',
      alive: num(s.alive) ?? 0,
      luma: num(s.luma) ?? 0,
      ...(onScreen?.length ? { onScreen } : {}),
      ...(count !== undefined && count >= 0 ? { wordsOnScreen: Math.round(count) } : {}),
      ...(num(s.textHeight) !== undefined ? { textHeight: num(s.textHeight) } : {}),
    }]
  })
}

/**
 * A review job's answer as the engine's review: its scenes (times, how much moves, brightness), its profile, and the
 * motion numbers the blueprint's style reads. Null when the answer has no scene list (a worker from before it). Pure.
 */
export function engineReview(review: ReviewResult): EngineReview | null {
  const scenes = checkedScenes(review.sceneList)
  if (!scenes.length) return null
  const profile = review.profile ?? {}
  const seconds = num(profile.seconds) ?? scenes.at(-1)!.end
  return {
    seconds,
    scenes: scenes.map((s) => ({ index: s.index, start: s.start, end: s.end, seconds: s.seconds, alive: s.alive, luma: s.luma })),
    profile,
    motion: { summary: { snap_share: profile.snap_share, overshoot_share: profile.overshoot_share } },
  }
}

/** The reference's blueprint from its review and its timed words (none when it has no transcript). Pure. */
export function buildBlueprint(assetId: string, review: ReviewResult, words: TimedWord[]): Blueprint | null {
  const engine = engineReview(review)
  return engine ? makeBlueprint(assetId, engine, words) : null
}

/**
 * What a scene shows, kept beside the blueprint: how it reads, how many headline words are on screen, and the text
 * read there (the reference's own words: shown to the agent fenced as data, never put on a storyboard).
 */
export type BlueprintScene = { index: number; start: number; end: number; shot: ReviewShot; textOnScreen: number; onScreen?: string[] }

/** The scene notes kept with a blueprint: at most four lines of on-screen text a scene, 120 characters each. Pure. */
export function blueprintScenes(scenes: ReviewScene[] | undefined): BlueprintScene[] {
  return checkedScenes(scenes).map((s) => {
    const onScreen = (s.onScreen ?? []).slice(0, 4).map((line) => line.slice(0, 120))
    return { index: s.index, start: s.start, end: s.end, shot: s.shot, textOnScreen: s.wordsOnScreen ?? 0, ...(onScreen.length ? { onScreen } : {}) }
  })
}

/** One line of storyboard_from_script (engine/ops.ts). */
export type BlueprintLine = { text: string; seconds: number; label: string; source: BeatSource; shot: string }

/**
 * The person's lines spread over `slots` beats, in order: with as many lines as beats or more, consecutive lines
 * share a beat (as evenly as their count allows). With fewer, the first beats get one each and the rest stay empty
 * for the words still to write. Pure.
 */
export function spreadLines(lines: string[], slots: number): string[] {
  const clean = lines.map((l) => l.trim()).filter(Boolean)
  if (slots <= 0) return []
  if (clean.length < slots) return Array.from({ length: slots }, (_, i) => clean[i] ?? '')
  return Array.from({ length: slots }, (_, k) => clean.slice(Math.floor((k * clean.length) / slots), Math.floor(((k + 1) * clean.length) / slots)).join(' '))
}

/** The picture source a visual beat starts with, from how its reference scene reads. Pure. */
const visualSource = (shot: ReviewShot | undefined): BeatSource => (shot === 'motion' ? 'broll' : 'scene')

/**
 * Storyboard lines in the blueprint's rhythm: one per beat, scaled to `seconds` (the reference's own length when
 * left out), the person's `lines` spread over the talk beats (over every beat when the reference never talks), and
 * shot notes that say where in the reference the beat comes from, how it reads, and how many words fit at its
 * pace. Never the reference's words. Pure.
 */
export function blueprintLines(blueprint: Blueprint, scenes: BlueprintScene[], options: { seconds?: number; lines?: string[] } = {}): BlueprintLine[] {
  const scale = options.seconds && blueprint.seconds > 0 ? options.seconds / blueprint.seconds : 1
  const pace = blueprint.pace || WORDS_PER_SECOND
  const talk = blueprint.beats.map((b, i) => (b.kind === 'talk' ? i : -1)).filter((i) => i >= 0)
  const targets = talk.length ? talk : blueprint.beats.map((_, i) => i)
  const spread = spreadLines(options.lines ?? [], targets.length)
  const words = new Map(targets.map((beat, k) => [beat, spread[k] ?? '']))
  return blueprint.beats.map((beat, i) => {
    const seconds = Math.min(600, Math.max(0.5, round(beat.seconds * scale, 1)))
    const scene = scenes.find((s) => s.index === beat.scene)
    const fits = Math.round(seconds * pace)
    const reads = scene ? `, reads as ${scene.shot}${scene.textOnScreen ? ` with ${scene.textOnScreen} words of text on screen` : ''}` : ''
    const spoken = beat.kind === 'talk' ? ` They spoke ${beat.words} words there (${beat.wordsPerSecond} a second). About ${fits} fit in this beat.` : ' No speech: the picture carries it.'
    const text = words.get(i) ?? ''
    return {
      text,
      seconds,
      label: `${beat.kind === 'talk' ? 'Talk' : 'Visual'} ${i + 1}`,
      source: beat.kind === 'talk' ? 'camera:A' : visualSource(scene?.shot),
      shot: `Reference ${mmss(beat.start)} to ${mmss(beat.end)} (scene ${beat.scene + 1}${reads}).${spoken}${text && wordCount(text) > fits * 1.25 ? ` These words run over (${wordCount(text)}).` : ''}`,
    }
  })
}
