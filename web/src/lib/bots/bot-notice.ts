/**
 * A notification that speaks for a bot (bots v3, docs/plans/bots-v3.md
 * "Attribution"). A notice an AI run leaves (the verdict digest, the "Flow
 * skipped" notice, `work_needs_you`, `work_failed`) names the teammate whose
 * run it was, and carries the sentence its bot says, on the row's `metadata`
 * (already jsonb, so no migration and no CHECK change):
 *
 *   teammate_id     the `ai_team_member` whose run left it (always, when set)
 *   teammate_name   its name, else its role's, when it could be read
 *   sentence        what the bot says: the server-written templated line
 *                   (narration.ts `verdictNoticeLine`, `skippedNoticeLine`,
 *                   `workNoticeLine`), never a model's
 *   work_item_id    the run's ledger row (`tracked_job.id`), when it has one
 *   capture_id      the capture the run was about, when known
 *   card_count      cards the run left for you (the verdict digest only)
 *   quiet           the run left nothing for you (a skipped run): the row is
 *                   kept, signed by the bot, but fires no banner and no toast
 *                   (bots-v3.md "What counts as output": nothing, silent)
 *   area            the area the work belongs to (one-agent plan, decision 9;
 *                   migration 318, work-area.ts), when known: the face is
 *                   picked from it, so the notices can be brought together
 *                   under one face later without touching the rows
 *
 * A notice with no teammate gets none of these keys: its row is exactly what
 * it was. A notice with one speaks AS the bot (1b, `botNoticeCopy`): its
 * `title` is the teammate's name and its `body` the sentence, so the banner,
 * the peek and the bot's Notices read the one text the server wrote. Without a
 * name (the read failed) the title stays the app's own.
 *
 * Where it lives (bots-v4 Phase 4c, decision 8): a notice that names a
 * teammate is its bot's (isBotNotice, BOT_NOTICE_TEAMMATE_PATH): the Notices
 * part of the bot's bubble and page lists it, and its banner fires as ever.
 *
 * Client-safe: the name read takes the caller's client (a type import only).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'
import { isAreaKey, type AreaKey } from '@/lib/packs/registry'

/** The bot keys on a notification's metadata. */
export interface BotNoticeMetadata {
  teammate_id: string
  teammate_name?: string
  sentence: string
  work_item_id?: string
  capture_id?: string
  card_count?: number
  quiet?: true
  area?: AreaKey
}

export interface BotNoticeFacts {
  teammateId: string | null | undefined
  teammateName?: string | null
  sentence: string
  workItemId?: string | null
  captureId?: string | null
  cardCount?: number | null
  /** Nothing for you (a skipped run): kept in its bot's Notices, no banner, no toast. */
  quiet?: boolean
  /** The work's area (migration 318), when known. */
  area?: string | null
}

/**
 * The metadata keys for a notice, to spread into the row's metadata: empty
 * when there is no teammate (the row stays as it was) or no sentence.
 */
export function botNoticeMetadata(facts: BotNoticeFacts): Partial<BotNoticeMetadata> {
  const teammateId = facts.teammateId?.trim()
  const sentence = facts.sentence?.trim()
  if (!teammateId || !sentence) return {}
  const name = facts.teammateName?.trim()
  return {
    teammate_id: teammateId,
    ...(name ? { teammate_name: name } : {}),
    sentence,
    ...(facts.workItemId ? { work_item_id: facts.workItemId } : {}),
    ...(facts.captureId ? { capture_id: facts.captureId } : {}),
    ...(typeof facts.cardCount === 'number' && facts.cardCount >= 0 ? { card_count: facts.cardCount } : {}),
    ...(facts.quiet ? { quiet: true as const } : {}),
    ...(isAreaKey(facts.area) ? { area: facts.area } : {}),
  }
}

/**
 * What a notice says when it speaks as its bot (1b): the teammate's name as
 * its title (else `plain.title`, when the name couldn't be read) and the
 * bot's sentence as its body. No bot keys: `plain` as it is.
 */
export function botNoticeCopy(
  metadata: Partial<BotNoticeMetadata> | Record<string, unknown>,
  plain: { title: string; body?: string | null },
): { title: string; body: string | undefined } {
  const bot = readBotNotice(metadata)
  if (!bot) return { title: plain.title, body: plain.body ?? undefined }
  return { title: bot.teammate_name ?? plain.title, body: bot.sentence }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** The bot keys off a notification's metadata, or null when it names no teammate. */
export function readBotNotice(metadata: unknown): BotNoticeMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>
  const teammateId = str(m.teammate_id)
  const sentence = str(m.sentence)
  if (!teammateId || !sentence) return null
  const name = str(m.teammate_name)
  const workItemId = str(m.work_item_id)
  const captureId = str(m.capture_id)
  const cardCount = typeof m.card_count === 'number' && Number.isFinite(m.card_count) ? m.card_count : undefined
  const quiet = m.quiet === true
  const area = isAreaKey(m.area) ? m.area : undefined
  return {
    teammate_id: teammateId,
    ...(name ? { teammate_name: name } : {}),
    sentence,
    ...(workItemId ? { work_item_id: workItemId } : {}),
    ...(captureId ? { capture_id: captureId } : {}),
    ...(cardCount !== undefined ? { card_count: cardCount } : {}),
    ...(quiet ? { quiet: true as const } : {}),
    ...(area ? { area } : {}),
  }
}

/**
 * Where a notice's teammate sits on its row, as a PostgREST filter path
 * (bots-v4 Phase 4c, decision 8): a bot's notices live with the bot, so the
 * plain notices the shell holds filter `is null` on it (notice-reach.ts
 * plainNotices), and a bot's Notices `eq` its id.
 */
export const BOT_NOTICE_TEAMMATE_PATH = 'metadata->>teammate_id'

/**
 * The teammate a notification's row names, as the database reads
 * `metadata->>teammate_id`: a string as it is, any other value as JSON, null
 * when it's missing or null. This, not `readBotNotice` (which also wants the
 * sentence), is the split's rule, so what the shell holds as a bot's here is
 * what the server reads as a bot's (bots-v4 Phase 4c).
 */
export function noticeTeammateId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const v = (metadata as Record<string, unknown>).teammate_id
  if (v === undefined || v === null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** A bot's notice (its row names a teammate): it lives with the bot (bots-v4 Phase 4c). */
export function isBotNotice(notification: { metadata?: unknown } | null | undefined): boolean {
  return noticeTeammateId(notification?.metadata) !== null
}

/** A notice as its bot's Notices read it. */
export interface BotNoticeRow {
  id: string
  type: string
  title: string
  body: string | null
  is_read: boolean
  is_archived?: boolean
  metadata?: unknown
  target_type?: string | null
  target_id?: string | null
}

/** What a notice says: its bot's sentence, else its body, else its title. */
export function noticeText(notice: Pick<BotNoticeRow, 'metadata' | 'body' | 'title'>): string {
  return readBotNotice(notice.metadata)?.sentence ?? (notice.body?.trim() || notice.title)
}

/** The work item a notice is about (the run that left it), or null. */
export function noticeWorkItemId(notice: Pick<BotNoticeRow, 'metadata' | 'target_type' | 'target_id'>): string | null {
  return readBotNotice(notice.metadata)?.work_item_id ?? (notice.target_type === 'work_item' ? (notice.target_id ?? null) : null)
}

/**
 * One bot's unread notices out of what the window holds (bots-v4 Phase 4c:
 * the desktop overlay's bubble lists these), newest first as held, leaving out
 * any about a work item the bubble already lists (`listed`: its card says it).
 * `ownerOf` says who stands for the teammate a notice names (one face: an
 * area face's notices are its workspace's Assistant's; agent-face.ts
 * teammateOwnerOf), each itself by default.
 */
export function unreadNoticesOf<T extends BotNoticeRow>(
  notices: readonly T[],
  teammateId: string,
  listed: ReadonlySet<string>,
  ownerOf: (teammateId: string) => string = (id) => id,
): T[] {
  return notices.filter((n) => {
    const named = noticeTeammateId(n.metadata)
    if (n.is_read || n.is_archived || !named || ownerOf(named) !== teammateId) return false
    const item = noticeWorkItemId(n)
    return !item || !listed.has(item)
  })
}

/** A teammate's name, else its role's, else null (the builder's default). */
export function teammateDisplayName(row: { name?: unknown; role?: unknown } | null | undefined): string | null {
  if (typeof row?.name === 'string' && row.name.trim()) return row.name.trim()
  return isWorkRole(row?.role) ? WORK_ROLE_LABELS[row.role] : null
}

/**
 * The name a notice signs with, read in the teammate's own workspace. Never
 * throws: a failed read gives null, and the notice goes out without the name.
 */
export async function noticeTeammateName(
  supabase: SupabaseClient,
  workspaceId: string,
  teammateId: string | null | undefined,
): Promise<string | null> {
  if (!teammateId) return null
  try {
    const { data } = await supabase
      .from('ai_team_member')
      .select('name, role')
      .eq('id', teammateId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return teammateDisplayName(data as { name?: unknown; role?: unknown } | null)
  } catch (err) {
    console.warn('[bots] notice teammate name read failed:', err instanceof Error ? err.message : err)
    return null
  }
}
