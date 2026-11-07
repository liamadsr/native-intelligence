/**
 * An unread failed run is new for its bot (bots-v4 Phase 4c, Liam on #653):
 * a bot's `work_failed` notice that hasn't been read (its item not opened, the
 * notice not clicked, its page's "Mark all read" not pressed) is something new
 * for that bot until it's read. Its other notices stay quiet.
 *
 * Where the person sees it: the agent tells it in the home thread (the router
 * routes a noticed failure `turn`: docs/plans/retire-notifications-page.md),
 * and its banner. This plumbing serves the agent's page only: its switcher's
 * dot (teammate-switcher.ts `hasNew`) and which item an Open of the bot starts
 * on (open-teammate.ts beckoningFor).
 *
 * It rides the shared counts (countByOwner's `beckoning`), as one entry per run,
 * FAILED_KEY_PREFIX and the run's id (the notice's own id when it names no
 * run). Not counted twice: a run whose own row already calls for you (it waits
 * on you again) adds nothing, and two notices about one run are one entry.
 * `needsYou` and `running` don't move: a failed run waits on nobody, so the
 * crew's "N waiting, N running" (Phase 4b) and its working/asleep state are as
 * they were.
 *
 * Nothing that turns an entry into a thing to show finds these (bubbleItems
 * knows rows and cards only): the deck, the peeks and the overlay's list skip
 * them, and the bubble's Notices part says the failure. The jumps skip them
 * too (teammate-bots.ts newKeysOf): the dot only, no hop and no coming for you.
 */
import { noticeTeammateId, readBotNotice } from './bot-notice'
import { teammateKey, type OwnerCounts } from '@/lib/work/agent-work-lanes'

/** A failed run's entry in `beckoning`: never a row's id (a uuid) or a card's, nor a run's cards' key (`work:` / `run:`). */
export const FAILED_KEY_PREFIX = 'failed:'

export function failedKey(id: string): string {
  return `${FAILED_KEY_PREFIX}${id}`
}

/** Whether a `beckoning` entry is an unread failed run's (see the module note). */
export function isFailedKey(id: string): boolean {
  return id.startsWith(FAILED_KEY_PREFIX)
}

/** A notice as these read it. */
export interface FailedNoticeLike {
  id: string
  type: string
  is_read: boolean
  is_archived?: boolean
  metadata?: unknown
  target_type?: string | null
  target_id?: string | null
}

/** An unread, unarchived failed run's notice that names its bot. */
export function isUnreadFailedNotice(n: FailedNoticeLike): boolean {
  return n.type === 'work_failed' && !n.is_read && !n.is_archived && noticeTeammateId(n.metadata) !== null
}

/**
 * `counts` with each unread failed run's notice in its bot's `beckoning` (see
 * the module note). `counts` itself when none adds anything; an owner it
 * changes gets a fresh entry (the shared one is never written to). `ownerOf`
 * says whose bot a notice's teammate is (one face: an area face's is its
 * workspace's Assistant's; agent-face.ts teammateOwnerOf), each its own by
 * default.
 */
export function withFailedNotices(
  counts: ReadonlyMap<string, OwnerCounts>,
  notices: readonly FailedNoticeLike[],
  ownerOf: (teammateId: string) => string = (id) => id,
): ReadonlyMap<string, OwnerCounts> {
  let out: Map<string, OwnerCounts> | null = null
  for (const n of notices) {
    if (!isUnreadFailedNotice(n)) continue
    const teammate = ownerOf(noticeTeammateId(n.metadata)!)
    const run = readBotNotice(n.metadata)?.work_item_id ?? (n.target_type === 'work_item' ? (n.target_id ?? null) : null)
    const entry = failedKey(run ?? n.id)
    const key = teammateKey(teammate)
    const c = (out ?? counts).get(key) ?? { running: 0, needsYou: 0, beckoning: [] }
    if (c.beckoning.includes(entry) || (run && c.beckoning.includes(run))) continue
    out ??= new Map(counts)
    out.set(key, { ...c, beckoning: [...c.beckoning, entry] })
  }
  return out ?? counts
}
