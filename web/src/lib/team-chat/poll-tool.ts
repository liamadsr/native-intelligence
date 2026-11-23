/**
 * The agent's poll tools' shared words (docs/plans/channels-inbox.md, phase
 * 3): their names, and what the person's approval card says before
 * post_team_chat_poll posts (the outward gate holds every call:
 * src/lib/safety/outward-gate.ts). Pure, so the gate and the tool agree.
 */
import { POLL_MAX_OPTIONS } from './polls'

export const READ_TEAM_CHAT_POLL = 'read_team_chat_poll' as const
export const POST_TEAM_CHAT_POLL = 'post_team_chat_poll' as const

function line(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/**
 * The card for a post_team_chat_poll call, from its own input: the
 * question, the options, how it's answered, and when it closes. The channel
 * is named by the tool's own read on replay (a model's label isn't trusted).
 */
export function pollCardCopy(input: unknown): { title: string; why: string } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const question = line(i.question, 160) || 'a poll'
  const options = (Array.isArray(i.options) ? i.options : []).slice(0, POLL_MAX_OPTIONS).map((o) => line(o, 60)).filter(Boolean)
  const how = [i.multiple === true ? 'people can pick more than one' : 'one choice each', i.anonymous === true ? 'anonymous' : null].filter(Boolean).join(', ')
  const closes = typeof i.closes_in_hours === 'number' && i.closes_in_hours > 0 ? ` It closes in ${Math.round(i.closes_in_hours)} hour${Math.round(i.closes_in_hours) === 1 ? '' : 's'}.` : ''
  return {
    title: `Post a poll: "${question}"`,
    why: `Your agent wants to post this poll in team chat, as your agent, where your teammates will see it and can vote. Options: ${options.length ? options.join(' · ') : 'none given'} (${how}).${closes}`,
  }
}
