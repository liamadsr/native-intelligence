// The words heard during a take, as the desktop streams them (`studio-recorder://live-words`): each event is either
// an interim guess at the words being said now (it replaces the last guess) or final words (kept; the guess is
// cleared). Events that arrive late or twice (an older `seq`) are dropped. Pure; tested in __tests__/live-words.test.ts.
import { tokenize, type Token } from './normalize'

export type LiveWord = { text: string; startMs: number; endMs: number }
export type LiveWordsEvent = { sessionId: string; seq: number; final: boolean; words: LiveWord[] }
export type Heard = { seq: number; finals: Token[]; interim: Token[] }

export const NOTHING_HEARD: Heard = { seq: -1, finals: [], interim: [] }
/** The most final words kept (the follower and the checklist look at far fewer). */
export const KEEP_FINALS = 200

/** Whether a payload is a live-words event (the desktop's shape; anything else is ignored). */
export function isLiveWordsEvent(raw: unknown): raw is LiveWordsEvent {
  if (!raw || typeof raw !== 'object') return false
  const e = raw as Record<string, unknown>
  return typeof e.sessionId === 'string' && typeof e.seq === 'number' && typeof e.final === 'boolean' && Array.isArray(e.words)
    && e.words.every((w) => !!w && typeof w === 'object' && typeof (w as Record<string, unknown>).text === 'string')
}

export function hear(heard: Heard, event: LiveWordsEvent): Heard {
  if (event.seq <= heard.seq) return heard
  const tokens = tokenize(event.words.map((w) => w.text).join(' '))
  if (!event.final) return { ...heard, seq: event.seq, interim: tokens }
  return { seq: event.seq, finals: [...heard.finals, ...tokens].slice(-KEEP_FINALS), interim: [] }
}
