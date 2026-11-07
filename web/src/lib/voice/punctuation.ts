/**
 * The full stop a dictation ends without (Liam, 2026-10-25: "zero
 * punctuation"). The on-device engine punctuates inside a stretch of speech
 * but never ends one with a full stop; the desktop puts them back where one
 * stretch meets the next (src-tauri/src/voice/transcript.rs sentence_break),
 * and this adds the last one when the dictation is committed.
 *
 * Generic: a finished sentence is three words or more ending in a letter or
 * digit, and not on a word no sentence ends on (English grammar, the same
 * list as the desktop's).
 */

const NO_SENTENCE_END = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'about', 'into', 'onto',
  'over', 'under', 'and', 'or', 'but', 'nor', 'so', 'because', 'if', 'than', 'that', 'which', 'who', 'whose',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'my', 'your', 'his', 'her', 'our', 'their', 'its',
  'this', 'these', 'those', 'very', 'just', 'um', 'uh', 'er', 'like',
])

/** `text` with a full stop at the end when it ends a sentence without one. */
export function finishSentence(text: string): string {
  const t = text.trimEnd()
  if (!/[\p{L}\p{N}]$/u.test(t)) return text
  const words = t.split(/\s+/)
  if (words.length < 3) return text
  const last = words[words.length - 1].toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
  if (NO_SENTENCE_END.has(last)) return text
  return `${t}.`
}
