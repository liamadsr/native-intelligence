/**
 * The backend's own fence on recording consent (roadmap #12,
 * docs/plans/agent-joins-meetings.md §2). GPT-Live is told to hand off and say
 * goodbye when anyone objects, but a prompt is not a guarantee, so the
 * bridge also reads what the meeting says and leaves on any of these, by
 * itself. A false positive costs one early exit, which is the right side to
 * err on. Pure.
 */

const OBJECTIONS: readonly RegExp[] = [
  /\b(?:please\s+)?(?:don'?t|do not|stop)\s+(?:record|recording|taking notes|transcrib)/i,
  /\b(?:i|we)\s+(?:don'?t|do not)\s+consent\b/i,
  /\bno\s+(?:recording|notes|note[- ]?taking|bots?|ai)\b(?:\s+(?:please|here|allowed))?/i,
  /\b(?:can|could|would|will)\s+(?:the|that|your)?\s*(?:bot|ai|assistant|robot)\s+(?:please\s+)?(?:leave|drop|hang up|go)\b/i,
  /\b(?:bot|ai|assistant),?\s+(?:please\s+)?(?:leave|drop off|hang up|go away)\b/i,
  /\b(?:not|isn'?t)\s+(?:comfortable|ok|okay)\s+with\s+(?:the\s+|an?\s+|this\s+)?(?:bot|ai|assistant|recording|being recorded|notes)\b/i,
  /\b(?:remove|kick)\s+(?:the\s+|that\s+)?(?:bot|ai|assistant)\b/i,
]

/** True when these words object to the assistant being there, or to notes. */
export function isObjection(words: string): boolean {
  const text = words.replace(/\s+/g, ' ')
  return OBJECTIONS.some((re) => re.test(text))
}
