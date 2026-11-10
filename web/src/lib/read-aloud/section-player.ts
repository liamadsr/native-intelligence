/**
 * The section player: reads a piece of content aloud through the desktop's
 * local-tts module, one at a time app-wide. It plays the hover play button on a
 * heading in rendered markdown (components/ui/markdown-sections.tsx) and in the
 * note editor (components/editor/read-aloud-sections-extension.ts), and the
 * Listen targets in listen mode: a document, an email, and a Listen brief (a
 * capture, a contact, an action…), components/read-aloud/listen-target.tsx.
 * What a section is and says is ./sections'; this module only speaks.
 *
 * `supported` is set by ReadAloudSectionsSupport (app/account), with the gate
 * the chat's useReadAloud uses: the desktop app, local-tts enabled and Ready,
 * no capture recording, not held by dictation or a Voice ID enrollment
 * (./mic-guard). Without it (a browser, the /s/ share pages, which have no
 * provider) nothing shows, and nothing here touches the bridge.
 *
 * One run = one key's sentences, read the way useReadAloud reads a reply: a
 * chained `tts_cancel` first, then one `tts_speak` per sentence, in order, ids
 * `section:${pageLoadId}:${n}`.
 *
 * The sentences can also still be on their way (a SentenceFeed: a Listen brief
 * being fetched, components/read-aloud/listen-brief.tsx). Each batch is spoken
 * as it arrives, and the run stays open (playing, with nothing queued) until
 * the feed ends. Its signal aborts the moment the run is over for any reason,
 * so a brief nobody will hear stops being fetched.
 *
 * Pause and resume (./resume-points): `pauseSection` cancels the desktop and
 * remembers the sentence the run stopped in (the one speaking, or the first
 * not yet done). Playing that key again starts from that sentence, clamped to
 * the sentences worked out now. Starting another key pauses the one playing,
 * and so does another reader taking the desktop, here or in another Native Intelligence
 * window (someone else's `cancelled`): a click never throws a place away. The
 * surfaces pause too when their item goes away (unmount).
 *
 * A run ends, with no point kept, when its last sentence is `done` (the next
 * play starts from the top, and `wasReadToTheEnd` says so until then, so
 * listen mode doesn't read it again on its own); on a true stop
 * (`stopSection`, read-aloud stops being supported, the page going away); and
 * on an `error` or a refused speak, cancelling the rest (a `text_too_long`
 * sentence is only skipped).
 *
 * The desktop has one queue, shared with every chat panel (./reader): the
 * latest reader wins. A section starting pauses a chat read, and a chat read
 * starting pauses the section, which then lets go without cancelling again.
 *
 * Interactive mode (components/read-aloud/interactive-voice-host.tsx) reads
 * the sentence being said (getSectionPlayingSentence: what the user was
 * listening to when they spoke), and each sentence is noted as it starts
 * speaking for its echo guard (./recent-speech).
 */

import { useSyncExternalStore } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'
import { speechOutput } from '@/lib/speech-output'
import { claimReader, releaseReader } from './reader'
import { noteSpoken } from './recent-speech'
import { setResumePoint, takeResumePoint } from './resume-points'
import { getReadAloudVoice } from './settings'

export interface SectionPlayerState {
  /** Read-aloud can play here now (see the header). False → no buttons. */
  supported: boolean
  /** The key of the section being read (the surface picks it), or null. */
  playingKey: string | null
}

const UNSUPPORTED: SectionPlayerState = Object.freeze({ supported: false, playingKey: null })

/** Hovering heading after heading warms the engine at most this often. */
const PREPARE_INTERVAL_MS = 20_000

/** Sentences still being worked out: batches, in order, until the iterable
 *  ends. `signal` aborts once the run no longer wants them (paused, stopped,
 *  replaced). A feed that throws ends like one that ended: what it gave is
 *  read to its end. */
export type SentenceFeed = (signal: AbortSignal) => AsyncIterable<readonly string[]>

/** What a run reads: its sentences, or a feed of them. */
export type SectionSentences = readonly string[] | SentenceFeed

interface Run {
  key: string
  /** Sent (or about to be) and not yet done: utterance id → the sentence's
   *  index in the key's sentences. In order, so the first is where a pause
   *  resumes. */
  pending: Map<string, number>
  /** Each sent sentence's text, by utterance id: what is being said now
   *  (getSectionPlayingSentence, Interactive mode's `readingAt`). */
  texts: Map<string, string>
  /** Every sentence has been sent. A feed's run is open until it ends: all
   *  done with more to come is not the end. */
  closed: boolean
  /** How many of a feed's sentences have arrived. */
  seen: number
  /** Aborts a feed's fetch when the run is over. */
  abort: AbortController | null
}

let state: SectionPlayerState = UNSUPPORTED
const listeners = new Set<() => void>()
/** The section player's identity in ./reader: one for every surface. */
const owner = {}
let run: Run | null = null
let chain: Promise<void> = Promise.resolve()
let inFlight = 0
let unlistenState: (() => void) | null = null
let lastPrepare = -Infinity
let onPageHide: (() => void) | null = null
let utteranceSeq = 0
/** Per page load: utteranceSeq restarts on a reload, the ids must not. */
const pageLoadId = Math.random().toString(36).slice(2, 8)

/** The desktop refused one sentence as too long; the rest can still go. */
const isTooLong = (err: unknown) => (err as { code?: unknown } | null)?.code === 'text_too_long'

function update(next: SectionPlayerState) {
  if (next.supported === state.supported && next.playingKey === state.playingKey) return
  state = next
  for (const listener of [...listeners]) listener()
}

/** Stop the desktop's audio now. A speak still in flight could land after this
 *  cancel, so one more cancel follows it through the chain. */
function cancelDesktop() {
  void speechOutput.cancel()
  if (inFlight > 0) chain = chain.then(() => speechOutput.cancel())
}

function stopListening() {
  unlistenState?.()
  unlistenState = null
}

/** Remember where `r` is (the first sentence not yet done), so playing its key
 *  again resumes there. */
function rememberPlace(r: Run) {
  for (const index of r.pending.values()) {
    setResumePoint(r.key, index)
    return
  }
  // A feed between batches: all it gave is done, the next one is still coming.
  if (!r.closed && r.seen > 0) setResumePoint(r.key, r.seen)
}

function endRun(cancel: boolean) {
  if (!run) return
  run.abort?.abort()
  run = null
  releaseReader(owner)
  stopListening()
  update({ ...state, playingKey: null })
  if (cancel) cancelDesktop()
}

/** A chat panel started reading: the run is paused where it was, and dropped
 *  without cancelling (the chat's own leading cancel clears the queue),
 *  exactly like a chat panel losing. */
function lose() {
  if (!run) return
  rememberPlace(run)
  run.abort?.abort()
  run = null
  stopListening()
  update({ ...state, playingKey: null })
}

function maybeFinish(r: Run) {
  if (run !== r || !r.closed || r.pending.size > 0) return
  markReadToTheEnd(r.key)
  endRun(false)
}

/** Keys read to their end, most recent last: listen mode doesn't read them
 *  again on its own when the user comes back to them (wasReadToTheEnd). */
const readToTheEnd = new Map<string, true>()
const MAX_READ_TO_THE_END = 100

function markReadToTheEnd(key: string) {
  readToTheEnd.delete(key)
  readToTheEnd.set(key, true)
  if (readToTheEnd.size > MAX_READ_TO_THE_END) readToTheEnd.delete(readToTheEnd.keys().next().value!)
}

/** Whether `key`'s last reading ran to its end (and it hasn't started again
 *  since): nothing of it is left to hear. */
export function wasReadToTheEnd(key: string): boolean {
  return readToTheEnd.has(key)
}

// ── tts://state: speaking / done / cancelled / error for our sentences ─────
function onTtsState(p: TtsStatePayload) {
  const current = run
  if (!current || !current.pending.has(p.id)) return
  if (p.state === 'speaking') {
    // The queue plays in order: whatever was sent before this one is over.
    for (const id of current.pending.keys()) {
      if (id === p.id) break
      current.pending.delete(id)
    }
    // Interactive mode's echo guard (./recent-speech).
    const text = current.texts.get(p.id)
    if (text) noteSpoken(text)
  } else if (p.state === 'done' || (p.state === 'error' && p.error === 'text_too_long')) {
    // `text_too_long` here: the sentence grew past the engine's limit when the
    // desktop spelled out its numbers. Skipped, like a refused speak.
    current.pending.delete(p.id)
    maybeFinish(current)
  } else if (p.state === 'cancelled') {
    // Not our cancel (ours ends the run first): another Native Intelligence window reading
    // (its listen mode following the user there), a chat panel there, the
    // Settings preview, dictation or Voice ID starting, or the desktop. A
    // pause: the place is kept, so this key picks up where it was when it
    // plays again (the user coming back to this window).
    rememberPlace(current)
    endRun(false)
  } else if (p.state === 'error') {
    // Don't read on past a sentence that failed.
    endRun(true)
  }
}

/** React runs no cleanup when the page goes away (reload, hard navigation,
 *  window closed), so the desktop would read on with no button anywhere. A
 *  true stop. Best effort: the desktop also cancels on page load. */
function bindPageHide() {
  if (onPageHide || typeof window === 'undefined') return
  onPageHide = () => endRun(true)
  window.addEventListener('pagehide', onPageHide)
}

/** Queue one sentence of `r`: one tts_speak, chained behind the ones before. */
function speak(r: Run, text: string, index: number, voice: string | undefined) {
  const id = `section:${pageLoadId}:${utteranceSeq++}`
  r.pending.set(id, index)
  r.texts.set(id, text)
  chain = chain.then(async () => {
    if (run !== r || !state.supported) {
      r.pending.delete(id)
      return
    }
    inFlight++
    try {
      await speechOutput.speak(voice ? { id, text, voice } : { id, text })
    } catch (err) {
      if (isTooLong(err)) {
        // Skip just this sentence and read on.
        r.pending.delete(id)
        maybeFinish(r)
      } else if (run === r) {
        // recording / not_ready / unavailable: this run can't go on.
        endRun(true)
      }
    } finally {
      inFlight--
    }
  })
}

/** Speak a feed's sentences as they arrive, from `start` (a resumed place) on,
 *  then close the run. */
async function follow(r: Run, feed: SentenceFeed, start: number, voice: string | undefined) {
  // The last sentence before `start`: said if the feed ends before reaching
  // it, the way a resume clamps to the last sentence when content shrank.
  let held: string | null = null
  try {
    for await (const batch of feed(r.abort!.signal)) {
      if (run !== r) return
      for (const text of batch) {
        const index = r.seen++
        if (index < start) {
          held = text
          continue
        }
        held = null
        speak(r, text, index, voice)
      }
    }
  } catch {
    // Failed or aborted: an aborted run is over already (below); a failed one
    // reads what it got.
  }
  if (run !== r) return
  if (held !== null) speak(r, held, r.seen - 1, voice)
  r.closed = true
  maybeFinish(r)
}

/**
 * Read `sentences` aloud as `key`, taking over from whatever reads now (a chat
 * reply, another section), which is paused. A key paused before resumes at
 * the sentence it stopped in, or the last one when the content has shrunk
 * since. A no-op when read-aloud is unsupported or there is nothing to say.
 *
 * A feed takes over at once, before its first sentence exists: it is what the
 * user opened now.
 */
export function playSection(key: string, sentences: SectionSentences): void {
  const feed = typeof sentences === 'function' ? sentences : null
  if (!state.supported || (!feed && sentences.length === 0)) return
  // Our own run, if any, keeps its place. Its chained sentences see it is no
  // longer current, and the cancel below clears what it had queued.
  if (run) {
    rememberPlace(run)
    run.abort?.abort()
  }
  claimReader(owner, lose)
  readToTheEnd.delete(key)
  // After the line above: playing the key that plays now picks up where it is.
  const saved = takeResumePoint(key)
  const next: Run = {
    key,
    pending: new Map(),
    texts: new Map(),
    closed: !feed,
    seen: 0,
    abort: feed ? new AbortController() : null,
  }
  run = next
  bindPageHide()
  if (!unlistenState) unlistenState = speechOutput.onState(onTtsState)
  update({ ...state, playingKey: key })

  // Clear the desktop's queue before the first sentence: chained, so the
  // cancel can never be handled after that sentence was queued.
  chain = chain.then(() => speechOutput.cancel())
  // Read once per run, so a voice picked in Settings applies from the next.
  const voice = getReadAloudVoice() ?? undefined
  if (feed) {
    // The first sentence is still being written: warm the engine meanwhile.
    prepareSectionPlayer()
    void follow(next, feed, saved ?? 0, voice)
    return
  }
  const list = sentences as readonly string[]
  const start = saved === null ? 0 : Math.min(saved, list.length - 1)
  for (let index = start; index < list.length; index++) speak(next, list[index], index, voice)
}

/** Pause now: any key, or only `key` when given. Cancels the desktop and keeps
 *  the place, so playing the key again resumes. Never touches someone else's
 *  read. */
export function pauseSection(key?: string): void {
  if (!run || (key !== undefined && run.key !== key)) return
  rememberPlace(run)
  endRun(true)
}

/** Pause the key being read if it starts with `prefix`: a surface (an editor)
 *  going away while one of its sections plays. */
export function pauseSectionIfKeyStartsWith(prefix: string): void {
  if (run?.key.startsWith(prefix)) pauseSection(run.key)
}

/** Stop reading now, keeping no place (the next play starts from the top):
 *  any key, or only `key` when given. The buttons pause instead. */
export function stopSection(key?: string): void {
  if (run && (key === undefined || run.key === key)) endRun(true)
}

/**
 * Set by ReadAloudSectionsSupport. Turning it off stops a run, cancelling the
 * desktop (a recording starting, dictation, the module going away).
 */
export function setSectionPlayerSupported(supported: boolean): void {
  if (supported === state.supported) return
  if (!supported) endRun(true)
  update({ ...state, supported })
}

/** Warm the engine on hovering an anchor, so its first sentence starts fast.
 *  At most once per PREPARE_INTERVAL_MS, and only where read-aloud works. */
export function prepareSectionPlayer(): void {
  if (!state.supported) return
  const now = Date.now()
  if (now - lastPrepare < PREPARE_INTERVAL_MS) return
  lastPrepare = now
  void speechOutput.prepare()
}

/** The sentence being read now (the one speaking, or else the first not yet
 *  done) and its key, or null while nothing reads. Interactive mode takes it
 *  as what the user was listening to when they spoke. */
export function getSectionPlayingSentence(): { key: string; text: string } | null {
  if (!run) return null
  for (const id of run.pending.keys()) {
    const text = run.texts.get(id)
    return text === undefined ? null : { key: run.key, text }
  }
  return null
}

export function subscribeSectionPlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSectionPlayerSnapshot(): SectionPlayerState {
  return state
}

const getServerSnapshot = () => UNSUPPORTED
const getSupported = () => state.supported
const getServerSupported = () => false

/** The section player's state, live. */
export function useSectionPlayer(): SectionPlayerState {
  return useSyncExternalStore(subscribeSectionPlayer, getSectionPlayerSnapshot, getServerSnapshot)
}

/** Only whether read-aloud can play here, live: no re-render as keys come
 *  and go. */
export function useSectionPlayerSupported(): boolean {
  return useSyncExternalStore(subscribeSectionPlayer, getSupported, getServerSupported)
}

/** Tests only: back to a fresh page (unsupported, idle, nothing bound). */
export function __resetSectionPlayerForTests(): void {
  stopListening()
  releaseReader(owner)
  run?.abort?.abort()
  run = null
  readToTheEnd.clear()
  chain = Promise.resolve()
  inFlight = 0
  lastPrepare = -Infinity
  if (onPageHide) window.removeEventListener('pagehide', onPageHide)
  onPageHide = null
  update(UNSUPPORTED)
}
