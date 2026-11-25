/**
 * One Home's decisions, in one place (docs/plans/one-home.md, "Open questions
 * for the owner"; all ten taken as recommended on 2026-11-25). The owner may
 * still change any of them before release: each is one value here, read by
 * the code that acts on it, and the plan's section says what the other choice
 * was.
 */

/**
 * 2. Pressing Code while a coding chat is open: `true`, it always starts a new
 * chat (the toggle starts, Recent resumes). `false`: Code comes back to the
 * coding chat the person was last on.
 */
export const CODE_PRESS_STARTS_NEW = true

/**
 * 3. One mixed Recent, with the coding chats a value of its Type filter: the word for them (the type's key stays
 * `agents`, so a saved filter holds). Defined beside the filter's other words.
 */
export { CODING_TYPE_LABEL } from '@/lib/entities/recents-model'

/**
 * 4. A half-typed message: each chat keeps its own draft. `true`: the words
 * still cross between the agent and a NEW coding chat when the other box is
 * empty (nothing was sent; the person is only choosing who gets them).
 */
export const DRAFT_PER_CHAT = true
export const DRAFT_CARRIES_TO_NEW_CODING_CHAT = true

/**
 * 5. After a reload: `'window'`, back on the chat this window was on (a new
 * window, or the desktop app started again, opens on the agent). `'agent'`:
 * always the agent.
 */
export const RELOAD_RESTORES: 'window' | 'agent' = 'window'

/** 6. The rail's Home button, pressed on Home with nothing in front: `true`, it goes to the agent. */
export const HOME_PRESS_GOES_TO_AGENT = true

/** 7. A coding chat the agent starts itself: `false`, it never takes the middle (a row in Recent, and Open on its chip). */
export const AGENT_STARTED_CHAT_TAKES_THE_MIDDLE = false

/** 8. The pinned row's label: the agent's own name and icon, nothing after it ('' ; e.g. ' · your agent'). */
export const PINNED_AGENT_SUFFIX = ''

/** 1. The Code view's own For you and the Code tab's dot are gone: the dot is on the chat's row. `true` puts the tab's dot back. */
export const CODE_TAB_DOT = false

/** The first-time line in a new coding chat's clear middle, until dismissed on this device. */
export const FIRST_TIME_LINE = 'Your coding chats are in Recent now, marked with the code icon.'
export const FIRST_TIME_KEY = 'ni:one-home:coding-in-recent'
