/**
 * The home thread (docs/plans/always-on-agent.md §2c, A3; decisions 1 and 2):
 * ONE conversation per person per workspace that every surface opens and that
 * never starts over. Side chats ("New chat", a focused area chat, a bot
 * conversation) stay ordinary rows.
 *
 * A home thread is an ordinary `chat_conversations` row with `is_home = true`
 * (migration 330): one per (user_id, workspace_id) by the unique index on
 * (user_id, workspace_id, is_home), whose NULLs are distinct, so every other
 * row is untouched by it. That is the shape migration 300 proved for teammate
 * threads, and {@link ensureHomeThread} is a copy of ensureTeammateThread:
 * read, then an ignore-duplicates upsert, then a re-read for the loser of a
 * race.
 *
 * It replaces the onboarding "home conversation" pointer that lived in
 * `member.onboarding_progress.conversation.homeConversationId` (a JSON field
 * with a known clobber trap). Migration 330 backfills the column from that
 * pointer, and nothing writes the pointer any more. It is still READ once, as
 * a fallback: when a person has no home row, ensureHomeThread adopts the
 * conversation their pointer names (their own plain row here) before creating
 * an empty one, so a pointer the old code wrote between the migration and the
 * deploy is never lost (adoptLegacyHome).
 *
 * Callers pass the tenancy pair from a verified principal: the mint and POST
 * /api/account/chat-history/home on the caller's RLS client, the onboarding
 * writers on theirs. The row is the pair's alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The home thread's title when this module creates it (onboarding passes its own). */
export const HOME_THREAD_TITLE = 'Home'

/** The longest checkpoint text stored (migration 330 allows 40K; the primer fences this much). */
export const HOME_CHECKPOINT_MAX_CHARS = 16_000

/** The caller's home thread in a workspace. */
export interface HomeThread {
  id: string
  /** The eve session registered on it, if any (the transport re-attaches). */
  eveSessionId: string | null
  /** True when this call created the row (an empty thread: no history primer). */
  created: boolean
}

interface HomeRow {
  id: string
  eve_session_id: string | null
}

/**
 * Get-or-create the person's ONE home thread in `workspaceId`. The common case
 * (it exists) is one read; the first call inserts with an ignored-duplicate
 * upsert on (user_id, workspace_id, is_home), so two first calls racing land
 * on one row, and the loser re-reads it. Throws on a query error.
 */
export async function ensureHomeThread(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; title?: string },
): Promise<HomeThread> {
  const { userId, workspaceId } = args
  const existing = await readHomeThread(supabase, userId, workspaceId)
  if (existing) return toThread(existing, false)

  // No home row yet: the onboarding conversation the old pointer named, when
  // it is still the person's own plain row here, becomes it (once).
  const adopted = await adoptLegacyHome(supabase, userId, workspaceId)
  if (adopted) return toThread(adopted, false)

  const { data: created, error } = await supabase
    .from('chat_conversations')
    .upsert(
      {
        user_id: userId,
        workspace_id: workspaceId,
        is_home: true,
        title: args.title ?? HOME_THREAD_TITLE,
      },
      { onConflict: 'user_id,workspace_id,is_home', ignoreDuplicates: true },
    )
    .select('id, eve_session_id')
    .maybeSingle<HomeRow>()
  if (error) throw new Error(`home thread create failed: ${error.message}`)
  if (created) return toThread(created, true)

  // Lost a race with another first call: its row is the thread.
  const raced = await readHomeThread(supabase, userId, workspaceId)
  if (!raced) throw new Error('home thread missing after upsert')
  return toThread(raced, false)
}

/** The person's home thread in `workspaceId`, or null when there is none yet. Throws on a query error. */
export async function readHomeThread(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<HomeRow | null> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id, eve_session_id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('is_home', true)
    .maybeSingle<HomeRow>()
  // A database without migration 330: there is no home thread to read or make.
  if (error?.code === UNDEFINED_COLUMN) throw new HomeThreadUnavailableError()
  if (error) throw new Error(`home thread lookup failed: ${error.message}`)
  return data ?? null
}

/** Whether `conversationId` is the person's home thread in `workspaceId`. Throws on a query error. */
export async function isHomeConversation(supabase: SupabaseClient, args: { conversationId: string; userId: string; workspaceId: string }): Promise<boolean> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id, is_home')
    .eq('id', args.conversationId)
    .eq('user_id', args.userId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle<{ is_home: boolean | null }>()
  if (error) throw new Error(`home thread check failed: ${error.message}`)
  return data?.is_home === true
}

/**
 * The database has no home thread column yet (migration 330 not applied):
 * callers answer "not available" instead of failing (POST /chat-history/home,
 * the mint's `home: true`), and nothing is created.
 */
export class HomeThreadUnavailableError extends Error {
  constructor() {
    super('home threads are not available on this database yet (migration 330)')
    this.name = 'HomeThreadUnavailableError'
  }
}

/** Postgres' unique-violation code. */
const UNIQUE_VIOLATION = '23505'

interface LegacyRow extends HomeRow {
  user_id: string
  workspace_id: string | null
  ai_team_member_id: string | null
  agent_teammate_id: string | null
  capture_id: string | null
  focus_area: string | null
  is_home: boolean | null
}

/**
 * The old onboarding pointer (`member.onboarding_progress.conversation
 * .homeConversationId`, no longer written), adopted as the home thread when
 * the person has none: only a row that is theirs, in this workspace, and
 * plain (no teammate, bot, live meeting or focus: migration 330's check). A
 * READ of the pointer; nothing writes it. Two adopters racing: the loser's
 * update hits the unique index (or finds the row already home) and re-reads.
 * Null when there is nothing to adopt. Throws only on a failed home re-read.
 *
 * This is what makes migration 330's "re-run it after the deploy" safe to
 * skip: a pointer the old code wrote in between is picked up here instead.
 */
async function adoptLegacyHome(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<HomeRow | null> {
  // A failed read throws: creating an empty home thread then would hide the
  // onboarding conversation for good, while a throw lets the next call retry.
  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('onboarding_progress')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ onboarding_progress: Record<string, unknown> | null }>()
  if (memberError) throw new Error(`onboarding pointer read failed: ${memberError.message}`)
  const pointer = (member?.onboarding_progress?.conversation as { homeConversationId?: unknown } | undefined)?.homeConversationId
  if (typeof pointer !== 'string' || !pointer) return null
  const { data: row, error: rowError } = await supabase
    .from('chat_conversations')
    .select('id, eve_session_id, user_id, workspace_id, ai_team_member_id, agent_teammate_id, capture_id, focus_area, is_home')
    .eq('id', pointer)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<LegacyRow>()
  if (rowError) throw new Error(`onboarding conversation read failed: ${rowError.message}`)
  if (!row || row.ai_team_member_id || row.agent_teammate_id || row.capture_id || row.focus_area) return null
  if (row.is_home === true) return row
  const { error } = await supabase
    .from('chat_conversations')
    .update({ is_home: true })
    .eq('id', row.id)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .is('is_home', null)
  if (error && error.code !== UNIQUE_VIOLATION) return null
  // Ours, or a racer's: whichever row is home now.
  return readHomeThread(supabase, userId, workspaceId)
}

/** PostgREST's code for a column the database doesn't have (migration 330 not applied). */
export const UNDEFINED_COLUMN = '42703'

function toThread(row: HomeRow, created: boolean): HomeThread {
  return { id: row.id, eveSessionId: row.eve_session_id ?? null, created }
}

/** A checkpoint's text, tidied and capped to HOME_CHECKPOINT_MAX_CHARS (its head: a summary leads with the gist). Null when blank. */
export function clipCheckpoint(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (!clean) return null
  return clean.length > HOME_CHECKPOINT_MAX_CHARS ? `${clean.slice(0, HOME_CHECKPOINT_MAX_CHARS - 1)}…` : clean
}

/**
 * Store eve's latest checkpoint text on the conversation (the memory route's
 * op 'checkpoint'), scoped to its owner and workspace. Idempotent: the same
 * text again (a replayed compaction.completed step) leaves checkpoint_at
 * alone. Only a home thread stores one (it is the only reader), and a
 * database without migration 330 stores nothing, so a replay never moves which messages count as "since". Returns
 * whether a row was written; throws on a query error.
 */
export async function storeCheckpoint(
  supabase: SupabaseClient,
  args: { conversationId: string; userId: string; workspaceId: string; text: string; now?: Date },
): Promise<{ stored: boolean; unchanged: boolean }> {
  const text = clipCheckpoint(args.text)
  if (!text) return { stored: false, unchanged: false }
  const { data: row, error: readError } = await supabase
    .from('chat_conversations')
    .select('id, checkpoint_summary, is_home')
    .eq('id', args.conversationId)
    .eq('user_id', args.userId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle<{ id: string; checkpoint_summary: string | null; is_home: boolean | null }>()
  // Without migration 330 there is nowhere to store it.
  if (readError?.code === UNDEFINED_COLUMN) return { stored: false, unchanged: false }
  if (readError) throw new Error(`checkpoint read failed: ${readError.message}`)
  // Only a home thread re-primes from its checkpoint (renderHomePrimer).
  if (!row || row.is_home !== true) return { stored: false, unchanged: false }
  if (row.checkpoint_summary === text) return { stored: false, unchanged: true }
  const { error } = await supabase
    .from('chat_conversations')
    .update({ checkpoint_summary: text, checkpoint_at: (args.now ?? new Date()).toISOString() })
    .eq('id', args.conversationId)
    .eq('user_id', args.userId)
    .eq('workspace_id', args.workspaceId)
  if (error) throw new Error(`checkpoint write failed: ${error.message}`)
  return { stored: true, unchanged: false }
}
