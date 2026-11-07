/**
 * Listen mode: while it is on, what the user opens is read aloud, or briefed:
 * an email thread (the whole conversation, ./email-thread-speech) and a
 * document read themselves, and a capture, a
 * contact, a company, a calendar event, a project or an action gets a few
 * spoken sentences about it (components/read-aloud/listen-brief.tsx). So
 * the user can browse without pressing anything on each. The auto-play lives
 * in the Listen targets' shared component (components/read-aloud/listen-target.tsx),
 * and the pulse around the window being read in
 * components/read-aloud/listen-frame.tsx. The chat has its own auto-read
 * setting and is left alone.
 *
 * The user sees it as INTERACTIVE (Liam, 2026-10-02: one toggle, renamed
 * from "Listen mode"): on, it reads as above AND, on a desktop that can, the
 * mic listens in the background for the user's assistant by name, so they can
 * talk back (components/read-aloud/interactive-voice-host.tsx, which pauses
 * the reading on the name and resumes it after the reply). The code keeps the
 * listen mode name.
 *
 * Toggled by Play / Pause in the top bar
 * (components/read-aloud/listen-mode-toggle.tsx), with a Next button beside
 * it while it is on and the item open offers what comes next (Mail's next
 * thread, Outlook's next conversation, Teams' next unread chat), and the mic
 * button on a desktop that runs Interactive's voice. Turning it off pauses
 * what the section player reads (a Listen item or a section button), keeping
 * its place (./resume-points), and stops listening.
 *
 * For this session only: a module store with no storage, so a reload starts
 * with it off.
 */

import { useSyncExternalStore } from 'react'
import { pauseSection } from './section-player'

let on = false
const listeners = new Set<() => void>()

export function isListenModeOn(): boolean {
  return on
}

export function setListenMode(next: boolean): void {
  if (next === on) return
  on = next
  if (!next) pauseSection()
  for (const listener of [...listeners]) listener()
}

export function subscribeListenMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether listen mode is on, live. */
export function useListenMode(): boolean {
  return useSyncExternalStore(subscribeListenMode, isListenModeOn, () => false)
}

/** Tests only: off, as on a fresh page. */
export function __resetListenModeForTests(): void {
  if (!on) return
  on = false
  for (const listener of [...listeners]) listener()
}
