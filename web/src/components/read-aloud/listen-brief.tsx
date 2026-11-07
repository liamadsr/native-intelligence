'use client'

/**
 * A Listen brief for the item on screen: in listen mode, opening it has the
 * app tell you about it in a few spoken sentences ("Pricing sync, on Tuesday,
 * with Jessa Lin and Jordan Lee from Acme." then the meeting's own summary),
 * said from what the workspace knows, with no model (how it works:
 * lib/listen-briefs/build.ts).
 *
 * A headless Listen target (./listen-target): it reads itself when the item
 * opens in listen mode, lights its window's pulse from that moment, pauses
 * and resumes with the top bar's toggle and as the user moves between windows
 * (from the very sentences it was saying), and starts over when reopened. Its
 * sentences are asked for only when it plays (@/lib/read-aloud/listen-briefs).
 *
 * `fallback` is the item's plain line from what is on screen ("Pricing sync,
 * with Jessa Lin."), said when no brief comes (offline, an error).
 */

import type { ListenBriefKind } from '@/lib/listen-briefs/kinds'
import { heardBrief, listenBriefFeed, listenBriefKey } from '@/lib/read-aloud/listen-briefs'
import { getResumePoint } from '@/lib/read-aloud/resume-points'
import { ListenTarget } from './listen-target'

export interface ListenBriefProps {
  kind: ListenBriefKind
  id: string
  /** What the screen shows about an item outside the database (a calendar
   *  event); read when the brief is asked for. */
  input?: unknown
  fallback?: () => readonly string[]
}

const NOTHING: readonly string[] = []

export function ListenBrief({ kind, id, input, fallback }: ListenBriefProps) {
  const key = listenBriefKey(kind, id)
  return (
    <ListenTarget
      listenKey={key}
      resumable={false}
      getSentences={() => {
        // Paused part-way (the user went to another window and came back):
        // the same sentences again, so it picks up exactly where it was.
        const resumed = getResumePoint(key) !== null ? heardBrief(key) : null
        return resumed ?? listenBriefFeed({ kind, id, input }, () => fallback?.() ?? NOTHING)
      }}
    />
  )
}
