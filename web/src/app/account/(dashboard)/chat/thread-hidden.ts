/**
 * The agent's thread while a coding chat stands where it does (docs/plans/
 * one-home.md, "What goes away"; Liam, 11-16: "the main chat and the agents
 * chats are showing at the same time" must never happen).
 *
 * It stays mounted, for its scroll position and its reply in flight, and is
 * put out of sight and out of reach by its OWN props, from the same render
 * that draws the coding chat (chat-panel.tsx reads Home's current chat for
 * both). No stylesheet rule and no injected <style>: a rule can be a stale
 * copy, or land a commit apart from the element it hides; a prop on the
 * element cannot.
 *
 *   inert        nothing in it takes the pointer, the focus or a reader;
 *   visibility   hidden, and opacity 0 too: a child with a visibility of its
 *                own (the scroll button) would otherwise show.
 */
import type { CSSProperties } from 'react'

const HIDDEN_STYLE: CSSProperties = { visibility: 'hidden', opacity: 0, pointerEvents: 'none' }

export interface HiddenThreadProps {
  inert?: boolean
  'aria-hidden'?: boolean
  'data-chat-thread-hidden'?: ''
  style?: CSSProperties
}

const SHOWN: HiddenThreadProps = {}
const HIDDEN: HiddenThreadProps = { inert: true, 'aria-hidden': true, 'data-chat-thread-hidden': '', style: HIDDEN_STYLE }

/** What the thread's own element wears: nothing while the agent's chat is the current one. */
export function hiddenThreadProps(hidden: boolean): HiddenThreadProps {
  return hidden ? HIDDEN : SHOWN
}
