'use client'

/**
 * A Listen target: one piece of content that read-aloud can read whole (a
 * document, an email thread with every message in it), or a spoken brief
 * about an item (./listen-brief: a capture, a contact, an action), on the
 * desktop's on-device voice, through the section player
 * (@/lib/read-aloud/section-player).
 * It has no UI of its own: it reads in listen mode, and the Interactive toggle
 * in the top bar (./listen-mode-toggle) is its only control. The sentences are
 * worked out when a reading starts, so what is read is the content as it is
 * then.
 *
 * Unmounting, or the key changing (the document or email closed, another one
 * opened), pauses its read, so nothing plays on with nothing on screen to
 * reach it, and reopening it resumes at the sentence it stopped in
 * (@/lib/read-aloud/resume-points). A target that isn't `resumable` (a Listen
 * brief, ./listen-brief) stops instead, and starts over when reopened.
 *
 * Listen mode (@/lib/read-aloud/listen-mode): while it is on, a target reads
 * its item on its own when it mounts (the item opened) and when its key
 * changes (the next email), resuming a paused key, else from the top; and when
 * listen mode turns on while it is shown, if nothing reads yet. Only a target
 * in the window the user works in does (useIsWindowFocused).
 *
 * Reading follows the user (Liam, 2026-09-28: "if it's reading a capture for
 * me and I click on the action item page … it should jump to reading the
 * action item, and if I jump back to the capture page it should resume from
 * where it left off"): a target whose window comes to the front (another
 * window or tab clicked, or this Native Intelligence window coming back from another one,
 * @/lib/read-aloud/app-focus) reads, resuming where it was paused, unless it
 * was already read to its end. What read elsewhere is paused by it, keeping
 * its place for when the user goes back. A short settle first, so flicking
 * through tabs doesn't start and stop each one.
 *
 * A target also tells the window around it that it is there (./listen-frame),
 * which is how listen mode's pulse knows which windows hold something to read,
 * and how the top bar's toggle knows there is something to read here. A
 * target can offer what comes next (`next`: Mail's next thread), which the top
 * bar shows as a Next button beside the toggle while listen mode is on (Liam,
 * 2026-10-02: "it would be cool if you can skip to the next thread"). Going
 * there swaps this target for the next item's, whose key reads itself in
 * listen mode, and this one's read is paused, as on any key change.
 *
 * Interactive mode (./interactive-voice-host) pauses the reading when the user
 * says the assistant's name, and picks it up again once the reply and its
 * follow-up window are over, through the controls a target hands its window
 * (./listen-frame, getFrontListenTarget): `resume` reads its item again from
 * the paused sentence (it owns getSentences), and `describe` (a browser page:
 * its tab title and host) says what the user was listening to.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useIsWindowFocused } from '@/components/views/unified-view-layout'
import { useAppFocused } from '@/lib/read-aloud/app-focus'
import {
  getSectionPlayerSnapshot,
  pauseSection,
  playSection,
  stopSection,
  wasReadToTheEnd,
  type SectionSentences,
} from '@/lib/read-aloud/section-player'
import { takeResumePoint } from '@/lib/read-aloud/resume-points'
import { isListenModeOn, useListenMode } from '@/lib/read-aloud/listen-mode'
import type { ListenTargetAbout } from '@/lib/voice/voice-ask'
import { useListenFrameTarget, type ListenNext, type ListenTargetControls } from './listen-frame'

/** How long a window stays in front before its target takes over reading. */
export const LISTEN_FOLLOW_SETTLE_MS = 300

export interface ListenTargetProps {
  /** Unique per piece of content, e.g. `doc:${id}`,
   *  `email-thread:${threadId}:${latestMessageId}`. */
  listenKey: string
  /** The sentences to read, in order, worked out when a reading starts.
   *  [] → nothing plays. Or a feed of them still being written (a Listen
   *  brief, ./listen-brief), read as they arrive. */
  getSentences: () => SectionSentences
  /** Reopened later, pick up where it was left (a document, an email). False
   *  starts it over each time it opens (a brief: a few sentences that make
   *  sense only from the top). Pausing and resuming with the toggle while it
   *  is open resumes either way. */
  resumable?: boolean
  /** What comes next, offered to the top bar's Next button while listen mode
   *  is on: `{ label: 'Next thread', go: onNext }`. Undefined: no button. A
   *  new `go` each render is fine (the latest one is called). */
  next?: ListenNext
  /** What this item says about itself to Interactive mode: a page in the
   *  in-app browser, its tab title and host (never its text). The latest one
   *  is called. */
  describe?: () => ListenTargetAbout | null
}

export function ListenTarget({ listenKey, getSentences, resumable = true, next, describe }: ListenTargetProps): null {
  const listenMode = useListenMode()
  const onScreen = useIsWindowFocused()
  const appFocused = useAppFocused()
  const inFront = onScreen && appFocused
  // Read in the effects only: the window's own focus changes are the follow
  // effect's to act on.
  const onScreenRef = useRef(onScreen)
  onScreenRef.current = onScreen
  const inFrontRef = useRef(inFront)
  inFrontRef.current = inFront
  const listenKeyRef = useRef(listenKey)
  listenKeyRef.current = listenKey
  const getSentencesRef = useRef(getSentences)
  getSentencesRef.current = getSentences

  // The offer the window passes on: one stable object per label, calling the
  // latest `go`, so the page re-rendering never churns the frame's store.
  const nextGoRef = useRef(next?.go)
  nextGoRef.current = next?.go
  const nextLabel = next?.label ?? null
  const offer = useMemo<ListenNext | null>(
    () => (nextLabel === null ? null : { label: nextLabel, go: () => nextGoRef.current?.() }),
    [nextLabel],
  )
  // Interactive mode's controls (./listen-frame): one stable object, calling
  // the latest key, sentences and description.
  const describeRef = useRef(describe)
  describeRef.current = describe
  const controls = useMemo<ListenTargetControls>(
    () => ({
      resume: () => {
        if (!isListenModeOn()) return
        playSection(listenKeyRef.current, getSentencesRef.current())
      },
      describe: () => describeRef.current?.() ?? null,
    }),
    [],
  )
  useListenFrameTarget(listenKey, offer, controls)

  // Closed or replaced while reading: pause (only if it is still ours), so
  // opening it again resumes; or, not resumable, stop and forget any place
  // (one kept by the toggle's pause too), so it opens from the top.
  const resumableRef = useRef(resumable)
  resumableRef.current = resumable
  useEffect(
    () => () => {
      if (resumableRef.current) {
        pauseSection(listenKey)
        return
      }
      stopSection(listenKey)
      takeResumePoint(listenKey)
    },
    [listenKey],
  )

  // Listen mode: this item opening (mount, a new key) reads it, and so does
  // listen mode turning on while nothing reads yet. Runs after the cleanup
  // above, so the item left behind is paused first.
  const listenModeWasRef = useRef(listenMode)
  useEffect(() => {
    const turnedOn = listenMode && !listenModeWasRef.current
    listenModeWasRef.current = listenMode
    if (!listenMode || !onScreenRef.current) return
    const reading = getSectionPlayerSnapshot().playingKey
    if (reading === listenKey) return
    // Turned on while something else reads (a section, a chat reply, an item
    // reading on in another window): this one doesn't take over from it.
    if (turnedOn && reading !== null) return
    playSection(listenKey, getSentencesRef.current())
  }, [listenMode, listenKey])

  // Reading follows the user: this window coming to the front reads this
  // item, unless it is already reading or was read to its end.
  useEffect(() => {
    if (!inFront || !isListenModeOn()) return
    const timer = setTimeout(() => {
      const key = listenKeyRef.current
      if (!inFrontRef.current || !isListenModeOn()) return
      if (getSectionPlayerSnapshot().playingKey === key || wasReadToTheEnd(key)) return
      playSection(key, getSentencesRef.current())
    }, LISTEN_FOLLOW_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [inFront])

  return null
}
