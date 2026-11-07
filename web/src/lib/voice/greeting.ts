/**
 * What voice mode says when it starts: one short line, spoken in the user's
 * read-aloud voice after the start chime. Random, never the same one twice in
 * a row (per window).
 */

export const VOICE_GREETINGS = ['Hey', 'Yo', "What's up?", 'What we doing?'] as const

let last: string | null = null

/** The next greeting. `random` is Math.random's shape (tests pass their own). */
export function pickGreeting(random: () => number = Math.random): string {
  const choices = VOICE_GREETINGS.filter((g) => g !== last)
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))
  last = choices[index]
  return last
}

/** Tests only. */
export function __resetGreetingForTests(): void {
  last = null
}
