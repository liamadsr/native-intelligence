/**
 * Filler words out of dictated text (Liam, 2026-10-25: "a switch … then it
 * would remove things like um"). Settings → Dictation → "Remove filler words",
 * on by default; device-local like the other voice settings.
 *
 * Only sounds that are never words: um, uh, er, erm, ah, hmm, mm and their
 * stretched spellings ("ummm", "uhh"). Not "like", "you know" or "I mean",
 * which often carry meaning. The commas around a filler go with it ("So, um,
 * we" → "So, we"), a sentence's last punctuation stays ("…there, uh." →
 * "…there."), and a sentence that began with one starts with a capital again.
 * Generic: no word list beyond the fillers themselves.
 */

export const REMOVE_FILLERS_KEY = 'dial8:dictation:remove-fillers'

const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+)$/i

/** On unless turned off. */
export function getRemoveFillers(): boolean {
  try {
    return typeof window === 'undefined' || window.localStorage.getItem(REMOVE_FILLERS_KEY) !== '0'
  } catch {
    return true
  }
}

export function setRemoveFillers(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(REMOVE_FILLERS_KEY)
    else window.localStorage.setItem(REMOVE_FILLERS_KEY, '0')
  } catch {
    // Storage unavailable: the default (on) stands.
  }
}

function isFiller(token: string): boolean {
  if (token.includes('-')) return false // "uh-huh", "mm-hmm" are answers, not fillers
  const core = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
  return core.length > 0 && FILLER.test(core)
}

/** The text without filler words. Unchanged when it has none. */
export function removeFillers(text: string): string {
  if (!text) return text
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.some(isFiller)) return text
  const out: string[] = []
  // A filler that began a sentence ("Um, so…", "…okay. Erm, next") hands its capital on.
  let capitalNext = false
  for (const token of tokens) {
    if (!isFiller(token)) {
      out.push(capitalNext ? token.replace(/^([^\p{L}]*)(\p{Ll})/u, (_, lead: string, c: string) => lead + c.toUpperCase()) : token)
      capitalNext = false
      continue
    }
    capitalNext = capitalNext || /^[^\p{L}]*\p{Lu}/u.test(token)
    // A sentence's end ("there uh." / "right, um?") stays on the word before.
    const end = token.match(/[.!?…]+["'”’)]*$/)?.[0]
    if (end && out.length) out[out.length - 1] = out[out.length - 1].replace(/,$/, '') + end
  }
  const result = out.join(' ')
  // A comma left dangling at the very end goes.
  return result.replace(/,$/, '').trim()
}
