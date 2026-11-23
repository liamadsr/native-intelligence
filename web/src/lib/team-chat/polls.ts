/**
 * Polls in a channel (docs/plans/channels-inbox.md, phase 3; migration 703).
 *
 * A poll is a message: "Poll: <question>" in the conversation, notified like
 * any other, with its own rows behind it (team_chat_poll, its options, its
 * votes). Anyone who may post in the channel votes: one option, or several
 * when it allows that; a second click takes a vote back. Its author (or the
 * person whose agent posted it) closes it, and a closing time closes it by
 * itself. Anonymous: only counts, for everyone, the author included.
 *
 * Every write goes through 703's functions (team_chat_poll_create,
 * team_chat_poll_vote, team_chat_poll_close), which hold the same rules as
 * the checks here; this file is the shared vocabulary, pure and client-safe:
 * the input checks, what a vote does, and how the card reads.
 *
 * Not the time-offer polls (src/lib/time-offers/polls.ts, migration 583):
 * those pick a meeting time with outside guests and book it.
 */

export const POLL_QUESTION_MAX = 300
export const POLL_OPTION_MAX = 120
export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 10
/** The latest a closing time may be (703 holds the same). */
export const POLL_CLOSES_MAX_MS = 90 * 24 * 60 * 60_000
/** A poll's message's words. */
export const POLL_BODY_PREFIX = 'Poll: '

/** A new poll as the dialog (or an agent) asks for it, checked. */
export interface PollDraft {
  question: string
  options: string[]
  multiple: boolean
  anonymous: boolean
  /** ISO, or null: open until its author closes it. */
  closes_at: string | null
}

/** One line of text, tidied: trimmed, inner runs of space as one. */
function tidyLine(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
}

/**
 * The request read and checked, nothing written: a question, 2 to 10
 * distinct options (blank ones dropped, the same option twice refused, any
 * case), the two switches, and a closing time in the future within 90 days.
 * Returns the draft, or why not.
 */
export function planPoll(input: unknown, now: Date = new Date()): { ok: true; draft: PollDraft } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'A poll needs a question and options' }
  const raw = input as Record<string, unknown>
  const question = tidyLine(raw.question)
  if (!question) return { ok: false, error: 'A poll needs a question' }
  if ([...question].length > POLL_QUESTION_MAX) return { ok: false, error: `A question is at most ${POLL_QUESTION_MAX} characters` }
  if (!Array.isArray(raw.options)) return { ok: false, error: 'A poll needs options' }
  const options = raw.options.map(tidyLine).filter(Boolean)
  if (options.length < POLL_MIN_OPTIONS) return { ok: false, error: `A poll needs at least ${POLL_MIN_OPTIONS} options` }
  if (options.length > POLL_MAX_OPTIONS) return { ok: false, error: `A poll has at most ${POLL_MAX_OPTIONS} options` }
  if (options.some((o) => [...o].length > POLL_OPTION_MAX)) return { ok: false, error: `An option is at most ${POLL_OPTION_MAX} characters` }
  const seen = new Set<string>()
  for (const o of options) {
    const key = o.toLocaleLowerCase()
    if (seen.has(key)) return { ok: false, error: `"${o}" is in the list twice` }
    seen.add(key)
  }
  let closes_at: string | null = null
  if (raw.closes_at != null && raw.closes_at !== '') {
    const at = typeof raw.closes_at === 'string' ? Date.parse(raw.closes_at) : NaN
    if (!Number.isFinite(at)) return { ok: false, error: 'The closing time must be a time' }
    if (at <= now.getTime()) return { ok: false, error: 'The closing time must be in the future' }
    if (at - now.getTime() > POLL_CLOSES_MAX_MS) return { ok: false, error: 'A poll closes within 90 days' }
    closes_at = new Date(at).toISOString()
  }
  return {
    ok: true,
    draft: { question, options, multiple: raw.multiple === true, anonymous: raw.anonymous === true, closes_at },
  }
}

/** A poll's message's words: what search, the thread and its notifications read. */
export function pollBody(question: string): string {
  return `${POLL_BODY_PREFIX}${question}`
}

/** A poll as 703's team_chat_poll_read answers it, for one reader. */
export interface TeamChatPoll {
  id: string
  channel_id: string
  message_id: string
  question: string
  multiple: boolean
  anonymous: boolean
  closes_at: string | null
  closed_at: string | null
  /** The member who made it (for an agent's poll: whose agent). */
  created_by: string | null
  created_at: string
  options: TeamChatPollOption[]
  /** How many people have voted (one each, however many options they chose). */
  voters: number
  /** The reader's own choices. */
  mine: string[]
  /** The reader may close it (its author, or whose agent posted it). */
  can_close: boolean
}

export interface TeamChatPollOption {
  id: string
  label: string
  position: number
  votes: number
  /** Who chose it (member ids); always empty when the poll is anonymous. */
  voter_ids: string[]
}

/** Closed: closed by hand, or its closing time has passed. */
export function isPollClosed(poll: Pick<TeamChatPoll, 'closed_at' | 'closes_at'>, now: Date = new Date()): boolean {
  if (poll.closed_at) return true
  if (!poll.closes_at) return false
  const at = Date.parse(poll.closes_at)
  return Number.isFinite(at) && at <= now.getTime()
}

/**
 * The reader's whole answer after a click on `optionId`: one choice
 * replaces the vote (or takes it back when it was the one chosen); several
 * toggle that option. What team_chat_poll_vote is sent.
 */
export function nextChoices(poll: Pick<TeamChatPoll, 'multiple'>, mine: readonly string[], optionId: string): string[] {
  const has = mine.includes(optionId)
  if (!poll.multiple) return has ? [] : [optionId]
  return has ? mine.filter((id) => id !== optionId) : [...mine, optionId]
}

/**
 * The poll as it looks right after the reader's own click, before the server
 * answers: their choices moved and the counts with them (the same arithmetic
 * 703's tally does).
 */
export function applyOwnVote(poll: TeamChatPoll, choices: readonly string[], meId: string | null): TeamChatPoll {
  const before = new Set(poll.mine)
  const after = new Set(choices)
  const wasVoter = before.size > 0
  const isVoter = after.size > 0
  return {
    ...poll,
    mine: [...choices],
    voters: Math.max(0, poll.voters + (isVoter ? 1 : 0) - (wasVoter ? 1 : 0)),
    options: poll.options.map((o) => {
      const delta = (after.has(o.id) ? 1 : 0) - (before.has(o.id) ? 1 : 0)
      if (delta === 0) return o
      const voter_ids =
        poll.anonymous || !meId ? o.voter_ids : delta > 0 ? [...o.voter_ids.filter((id) => id !== meId), meId] : o.voter_ids.filter((id) => id !== meId)
      return { ...o, votes: Math.max(0, o.votes + delta), voter_ids }
    }),
  }
}

/** An option's share of the voters, 0-100, rounded (a bar's width). Several choices: each of the voters'. */
export function optionPercent(option: Pick<TeamChatPollOption, 'votes'>, voters: number): number {
  if (voters <= 0) return 0
  return Math.round((option.votes / voters) * 100)
}

/** The leading options (ties all lead); none before anyone votes. */
export function leadingOptionIds(poll: Pick<TeamChatPoll, 'options'>): string[] {
  const top = Math.max(0, ...poll.options.map((o) => o.votes))
  return top === 0 ? [] : poll.options.filter((o) => o.votes === top).map((o) => o.id)
}

/**
 * The card's footer: "3 votes · Pick one · Closes in 2 hours" while open,
 * "Final results · 3 votes" once closed. Anonymous says so.
 */
export function pollStatusLine(poll: TeamChatPoll, now: Date = new Date()): string {
  const votes = `${poll.voters} ${poll.voters === 1 ? 'vote' : 'votes'}`
  const anon = poll.anonymous ? ' · Anonymous' : ''
  if (isPollClosed(poll, now)) return `Final results · ${votes}${anon}`
  const how = poll.multiple ? 'Pick any' : 'Pick one'
  const closes = poll.closes_at ? ` · Closes ${untilWords(Date.parse(poll.closes_at) - now.getTime())}` : ''
  return `${votes} · ${how}${anon}${closes}`
}

/** "in 5 minutes", "in 3 hours", "in 2 days": how long is left, rounded down, at least a minute. */
export function untilWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.floor(hours / 24)
  return `in ${days} days`
}

/** The dialog's closing-time choices. */
export const POLL_CLOSE_CHOICES = ['none', 'hour', 'day', 'week'] as const
export type PollCloseChoice = (typeof POLL_CLOSE_CHOICES)[number]

export function pollClosesAt(choice: PollCloseChoice, now: Date = new Date()): string | null {
  if (choice === 'none') return null
  const ms = choice === 'hour' ? 3_600_000 : choice === 'day' ? 86_400_000 : 7 * 86_400_000
  return new Date(now.getTime() + ms).toISOString()
}
