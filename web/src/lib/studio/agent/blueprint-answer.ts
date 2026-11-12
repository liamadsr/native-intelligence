/**
 * A reference blueprint as the agent reads it (get_studio_blueprint, src/lib/ai/tools/studio-blueprint.ts): the beat
 * grid compact (each beat's times, seconds, kind, word count and pace, how its scene reads), the pace and cut
 * numbers, and apart from them the reference's own words (what was said in each beat, the text read on screen),
 * which the tool fences as outside text. Pure.
 */
import type { Blueprint } from '@/lib/studio/engine/blueprint'
import type { BlueprintScene } from '@/lib/studio/server/blueprint-lines'

/** How many beats one answer lists at most (the rest are counted). */
export const BEATS_MAX = 40

/** Characters of a beat's words, or a scene's text, an answer keeps. */
const SAID_MAX = 240

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** The pace and style numbers worth reading, the ones measured. Pure. */
function paceOf(b: Blueprint) {
  const s = b.style
  return {
    words_per_second: b.pace,
    speech_share: b.speechShare,
    cuts_per_minute: s.cutsPerMinute,
    median_scene_seconds: s.medianScene,
    ...(s.alive !== undefined ? { moving_share: s.alive } : {}),
    ...(s.movesPerSecond !== undefined ? { moves_per_second: s.movesPerSecond } : {}),
    ...(s.textHeight ? { text_height: s.textHeight } : {}),
    ...(s.wordsOnScreen ? { words_on_screen: s.wordsOnScreen } : {}),
    ...(s.luma !== undefined ? { brightness: s.luma } : {}),
    ...(s.palette?.length ? { palette: s.palette } : {}),
  }
}

/** The blueprint's numbers and beats, without the reference's words. Pure. */
export function compactBlueprint(b: Blueprint, scenes: BlueprintScene[]) {
  const sceneOf = new Map(scenes.map((s) => [s.index, s]))
  return {
    seconds: b.seconds,
    scenes: b.scenes.length,
    pace: paceOf(b),
    beats: b.beats.slice(0, BEATS_MAX).map((beat, i) => {
      const scene = sceneOf.get(beat.scene)
      return {
        beat: i + 1,
        from: beat.start,
        to: beat.end,
        seconds: beat.seconds,
        kind: beat.kind,
        scene: beat.scene + 1,
        ...(scene ? { shot: scene.shot } : {}),
        ...(scene?.textOnScreen ? { text_on_screen_words: scene.textOnScreen } : {}),
        ...(beat.kind === 'talk' ? { words: beat.words, words_per_second: beat.wordsPerSecond } : {}),
      }
    }),
    ...(b.beats.length > BEATS_MAX ? { more_beats: b.beats.length - BEATS_MAX } : {}),
  }
}

/**
 * The reference's own words, one line a beat (what was said) and one a scene (the text read on screen), for the tool
 * to fence as outside text. Empty when it has none. Pure.
 */
export function referenceWordsText(b: Blueprint, scenes: BlueprintScene[]): string {
  const said = b.beats.slice(0, BEATS_MAX).flatMap((beat, i) => (beat.said ? [`Beat ${i + 1} (${mmss(beat.start)} to ${mmss(beat.end)}) said: ${beat.said.slice(0, SAID_MAX)}`] : []))
  const shown = scenes.flatMap((s) => (s.onScreen?.length ? [`Scene ${s.index + 1} shows text: ${s.onScreen.join(' / ').slice(0, SAID_MAX)}`] : []))
  return [...said, ...shown].join('\n')
}
