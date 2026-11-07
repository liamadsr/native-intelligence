/**
 * The client half of Listen briefs (how they work: lib/listen-briefs/build.ts):
 * asks /api/account/listen/brief what to say about an item, and hands the
 * sentences to the section player as a SentenceFeed, so its read starts (and
 * the window lights up) the moment the item opens, and a read that stopped
 * (paused, the item closed, another one opened) aborts the request.
 *
 * Never silent: when there is no brief (offline, an item the server can't
 * find) the feed says the item's own plain line instead (`fallback`, from
 * what is on screen).
 *
 * Skimming past items (holding the arrow key down a list) asks for none of
 * them: a brief is asked for once its item has stayed open for
 * BRIEF_SETTLE_MS.
 */

import type { ListenBriefKind } from '@/lib/listen-briefs/kinds'
import type { SentenceFeed } from './section-player'

export const LISTEN_BRIEF_ENDPOINT = '/api/account/listen/brief'

/** How long an item stays open before its brief is asked for. */
export const BRIEF_SETTLE_MS = 150
let settleMs = BRIEF_SETTLE_MS

/** Resolves after `ms`, or at once when `signal` aborts. */
function settle(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

export interface ListenBriefSubject {
  kind: ListenBriefKind
  id: string
  /** What the screen shows about an item that lives outside the database (a
   *  calendar event). */
  input?: unknown
}

/** Its read-aloud key: `brief:capture:<id>`. */
export function listenBriefKey(kind: ListenBriefKind, id: string): string {
  return `brief:${kind}:${id}`
}

function userTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** Briefs heard lately, by key: a brief paused when the user moved to another
 *  window resumes from exactly these sentences, at once, when they come back
 *  (the place kept is an index into them). */
const heard = new Map<string, { sentences: string[]; at: number }>()
const HEARD_KEEP_MS = 15 * 60_000
const HEARD_MAX = 30

function keepHeard(key: string, sentences: string[]) {
  heard.delete(key)
  heard.set(key, { sentences, at: Date.now() })
  if (heard.size > HEARD_MAX) heard.delete(heard.keys().next().value!)
}

/** The sentences `key`'s brief said lately, or null. */
export function heardBrief(key: string): string[] | null {
  const kept = heard.get(key)
  if (!kept) return null
  if (Date.now() - kept.at > HEARD_KEEP_MS) {
    heard.delete(key)
    return null
  }
  return kept.sentences
}

/** The brief as a feed, or `fallback()`'s sentences when there is none. */
export function listenBriefFeed(subject: ListenBriefSubject, fallback: () => readonly string[]): SentenceFeed {
  return async function* feed(signal) {
    await settle(settleMs, signal)
    if (signal.aborted) return
    let sentences: string[] = []
    try {
      const res = await fetch(LISTEN_BRIEF_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: subject.kind, id: subject.id, timeZone: userTimeZone(), input: subject.input }),
        signal,
      })
      if (res.ok) {
        const body = (await res.json()) as { sentences?: unknown }
        if (Array.isArray(body.sentences)) {
          sentences = body.sentences.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        }
      }
    } catch (err) {
      if (signal.aborted) return
      console.warn('[listen-brief] no brief:', err)
    }
    if (signal.aborted) return
    if (sentences.length) keepHeard(listenBriefKey(subject.kind, subject.id), sentences)
    const said = sentences.length ? sentences : fallback()
    if (said.length) yield said
  }
}

/** An item's plain line, for a fallback: "Pricing sync, with Jessa Lin and
 *  Jordan Lee." Nothing to say without a name. */
export function plainLine(name: string | null | undefined, ...details: Array<string | null | undefined | false>): string[] {
  const head = name?.trim()
  if (!head) return []
  const rest = details.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
  return [`${[head, ...rest].join(', ')}.`]
}

/** "Jessa Lin", "Jessa Lin and Jordan Lee", "Jessa Lin, Jordan Lee and 3 others". */
export function namesLine(names: ReadonlyArray<string | null | undefined>): string | null {
  const kept = names.map((n) => n?.trim()).filter((n): n is string => !!n)
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]
  if (kept.length === 2) return `${kept[0]} and ${kept[1]}`
  if (kept.length === 3) return `${kept[0]}, ${kept[1]} and ${kept[2]}`
  return `${kept[0]}, ${kept[1]} and ${kept.length - 2} others`
}

/** Tests only: how long an item settles before its brief is asked for. */
export function __setBriefSettleForTests(ms: number): void {
  settleMs = ms
}

/** Tests only: forget the briefs heard. */
export function __clearHeardBriefsForTests(): void {
  heard.clear()
}
