/**
 * Channel polls' reads and writes (migration 703), always as the person:
 * every call takes THEIR Supabase client, and 703's functions hold the rules
 * (may they post here, is it open, are these the poll's own options, are they
 * its author) under the poll's lock. Vocabulary and checks: ./polls.ts.
 *
 *   createPoll  team_chat_poll_create: the message ("Poll: <question>"), the
 *               poll and its options, in one go; returns their ids.
 *   readPoll    team_chat_poll_read: the poll as this reader sees it (their
 *               own choices; who chose what only when it isn't anonymous).
 *   votePoll    team_chat_poll_vote: the reader's whole answer, replaced.
 *   closePoll   team_chat_poll_close: its author (or whose agent posted it).
 *
 * Each throws a TeamChatError (./store.ts) on a failed call.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TeamChatError, teamChatErrorOf } from './store'
import type { PollDraft, TeamChatPoll, TeamChatPollOption } from './polls'
import { isUuid } from './types'

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 703's jsonb poll, checked into the shape the card reads (null when it isn't one). */
export function pollFromRow(raw: unknown): TeamChatPoll | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isUuid(r.id) || !isUuid(r.channel_id) || !isUuid(r.message_id) || typeof r.question !== 'string') return null
  const options = (Array.isArray(r.options) ? r.options : [])
    .map((o): TeamChatPollOption | null => {
      if (!o || typeof o !== 'object') return null
      const x = o as Record<string, unknown>
      if (!isUuid(x.id) || typeof x.label !== 'string') return null
      return {
        id: x.id,
        label: x.label,
        position: Number(x.position) || 0,
        votes: Math.max(0, Number(x.votes) || 0),
        voter_ids: r.anonymous === true ? [] : (Array.isArray(x.voter_ids) ? x.voter_ids : []).filter(isUuid),
      }
    })
    .filter((o): o is TeamChatPollOption => o !== null)
  return {
    id: r.id,
    channel_id: r.channel_id,
    message_id: r.message_id,
    question: r.question,
    multiple: r.multiple === true,
    anonymous: r.anonymous === true,
    closes_at: asString(r.closes_at),
    closed_at: asString(r.closed_at),
    created_by: isUuid(r.created_by) ? r.created_by : null,
    created_at: asString(r.created_at) ?? new Date(0).toISOString(),
    options,
    voters: Math.max(0, Number(r.voters) || 0),
    mine: (Array.isArray(r.mine) ? r.mine : []).filter(isUuid),
    can_close: r.can_close === true,
  }
}

export async function createPoll(
  supabase: SupabaseClient,
  input: { channelId: string; draft: PollDraft; threadRootId: string | null; clientId: string | null },
): Promise<{ messageId: string; pollId: string }> {
  const { data, error } = await supabase.rpc('team_chat_poll_create', {
    ch: input.channelId,
    question: input.draft.question,
    options: input.draft.options,
    multiple: input.draft.multiple,
    anonymous: input.draft.anonymous,
    closes_at: input.draft.closes_at,
    thread_root: input.threadRootId,
    client: input.clientId,
  })
  if (error) throw teamChatErrorOf(error, 'poll create')
  const row = (data ?? {}) as { message_id?: unknown; poll_id?: unknown }
  if (!isUuid(row.message_id) || !isUuid(row.poll_id)) throw new TeamChatError('failed', 'poll create returned nothing')
  return { messageId: row.message_id, pollId: row.poll_id }
}

/** The poll as the reader sees it, or null when it isn't there for them. */
export async function readPoll(supabase: SupabaseClient, pollId: string): Promise<TeamChatPoll | null> {
  const { data, error } = await supabase.rpc('team_chat_poll_read', { poll: pollId })
  if (error) {
    if (error.code === '42501' || error.code === 'P0002') return null
    throw teamChatErrorOf(error, 'poll read')
  }
  return pollFromRow(data)
}

export async function votePoll(supabase: SupabaseClient, pollId: string, optionIds: readonly string[]): Promise<TeamChatPoll> {
  const { data, error } = await supabase.rpc('team_chat_poll_vote', { poll: pollId, option_ids: [...optionIds] })
  if (error) throw teamChatErrorOf(error, 'vote')
  const poll = pollFromRow(data)
  if (!poll) throw new TeamChatError('failed', 'vote returned nothing')
  return poll
}

export async function closePoll(supabase: SupabaseClient, pollId: string): Promise<TeamChatPoll> {
  const { data, error } = await supabase.rpc('team_chat_poll_close', { poll: pollId })
  if (error) throw teamChatErrorOf(error, 'poll close')
  const poll = pollFromRow(data)
  if (!poll) throw new TeamChatError('failed', 'poll close returned nothing')
  return poll
}

/** The distinct option ids of a vote request (at most the poll's maximum), or null when it isn't a list of ids. */
export function tidyOptionIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 10 || !raw.every(isUuid)) return null
  return [...new Set((raw as string[]).map((id) => id.toLowerCase()))]
}
