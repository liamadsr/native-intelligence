/**
 * A Studio script as the agent writes and reads it: plain text, one block per
 * beat, blocks separated by a blank line. A block may start with its length
 * and its name, `[5s] Hook: The words said…`; both are optional.
 *
 *   [3s] Hook: Your inbox, finally quiet.
 *
 *   Every reply drafted before you open it.
 *
 * The stored script (studio_script.beats, migration 620) is the list
 * `{ text, seconds?, label? }` the teleprompter reads and a storyboard starts
 * from (storyboard_from_script). Pure.
 */

/** One beat of a script. */
export interface ScriptBeat {
  text: string
  seconds?: number
  label?: string
}

/** The most beats one script holds (the stored script's limit, src/lib/studio/server/scripts.ts). */
export const SCRIPT_MAX_BEATS = 100
/** The most characters one beat's words hold (the same). */
export const SCRIPT_MAX_TEXT = 2000
/** The longest beat, in seconds (the storyboard's own limit). */
export const SCRIPT_MAX_SECONDS = 600

const HEAD = /^\[\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s*\]\s*/i
const LABEL = /^([^:\n]{1,60}):\s+/

/** The script's text as beats, or the one thing wrong with it. */
export function parseScriptText(text: string): { ok: true; beats: ScriptBeat[] } | { ok: false; error: string } {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (!blocks.length) return { ok: false, error: 'text is empty: write the script as blocks separated by a blank line.' }
  if (blocks.length > SCRIPT_MAX_BEATS) return { ok: false, error: `A script holds at most ${SCRIPT_MAX_BEATS} beats; this one has ${blocks.length}.` }
  const beats: ScriptBeat[] = []
  for (const [i, block] of blocks.entries()) {
    let rest = block
    let seconds: number | undefined
    const head = HEAD.exec(rest)
    if (head) {
      seconds = Number(head[1])
      if (!(seconds >= 0.3 && seconds <= SCRIPT_MAX_SECONDS)) return { ok: false, error: `Beat ${i + 1}: [${head[1]}s] is not a length a beat can have (0.3 to ${SCRIPT_MAX_SECONDS} seconds).` }
      rest = rest.slice(head[0].length)
    }
    let label: string | undefined
    const named = LABEL.exec(rest)
    // A label is a short name before a colon; a sentence with a colon in it is words.
    if (named && named[1].trim().split(/\s+/).length <= 5) {
      label = named[1].trim()
      rest = rest.slice(named[0].length)
    }
    const words = rest.replace(/\s*\n\s*/g, ' ').trim()
    if (!words) return { ok: false, error: `Beat ${i + 1} has no words: write what is said (or shown) in it.` }
    if (words.length > SCRIPT_MAX_TEXT) return { ok: false, error: `Beat ${i + 1} is longer than ${SCRIPT_MAX_TEXT} characters: split it with a blank line.` }
    beats.push({ text: words, ...(seconds !== undefined ? { seconds } : {}), ...(label ? { label } : {}) })
  }
  return { ok: true, beats }
}

/** Beats back as the text the agent writes. */
export function scriptText(beats: readonly ScriptBeat[]): string {
  return beats
    .map((b) => {
      const head = b.seconds !== undefined ? `[${+b.seconds.toFixed(2)}s] ` : ''
      const label = b.label ? `${b.label}: ` : ''
      return `${head}${label}${b.text}`.trim()
    })
    .join('\n\n')
}

/** Seconds the script runs: the beats' own lengths, else its words at the speaking pace. */
export function scriptSeconds(beats: readonly ScriptBeat[], wordsPerSecond = 2.6): number {
  const total = beats.reduce((n, b) => n + (b.seconds ?? (b.text.trim() ? b.text.trim().split(/\s+/).length / wordsPerSecond : 0)), 0)
  return Math.round(total * 10) / 10
}
