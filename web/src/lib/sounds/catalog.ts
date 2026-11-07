/**
 * The UI sounds the app ships: one `public/sounds/<name>.m4a` per name, made
 * by `npm run sounds` (scripts/sounds/make-sounds.py: levelled to the same
 * loudness, AAC-LC because macOS 13's WebView can't decode Opus).
 *
 * A test holds this list and the directory to each other: every name has a
 * file and every file has a name.
 */

/** The sounds something in the app plays. A sound made for later, that nothing
 *  plays yet, goes in a list of its own so nothing preloads it. */
export const SOUND_NAMES = [
  'stt-dictate-start',
  'stt-dictate-end',
  'voice-chat-start',
  'voice-chat-end',
  'agent-alert',
  'agent-complete',
  'notification-alert',
  // An AI teammate's arrivals (./triggers teammateArrivalSound): a new card,
  // finished work to review, a question waiting on you.
  'agent-alert-arivel',
  'agent-alert-hopful',
  'agent-alert-questions',
] as const

export type SoundName = (typeof SOUND_NAMES)[number]

/** What the engine loads ahead of a first play: the sounds something plays. */
export const PRELOADED_SOUND_NAMES: readonly SoundName[] = SOUND_NAMES

const NAMES: ReadonlySet<string> = new Set(SOUND_NAMES)

export function isSoundName(value: unknown): value is SoundName {
  return typeof value === 'string' && NAMES.has(value)
}

/** Where the browser fetches a sound from (served from `public/`). */
export function soundUrl(name: SoundName): string {
  return `/sounds/${name}.m4a`
}
