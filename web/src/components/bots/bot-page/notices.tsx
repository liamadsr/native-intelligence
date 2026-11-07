'use client'

/**
 * Notices, on a bot's page (docs/plans/bots-v4.md, "A bot's page" and Phase
 * 4c, decision 8): its notices, newest first, read and unread, the unread ones
 * marked (a dot, the sentence in full weight) and counted beside the title.
 * A notice the bot's run left lives with the bot: this is where it's listed.
 *
 * Read through useBotNotices (GET /api/account/notifications/bot?teammate=,
 * PAGE_NOTICES_LIMIT of them, and that many more at each "Show more", up to
 * PAGE_NOTICES_MAX) while the page's lists are drawn: coming back from an item
 * reads them again. A click opens its item on this page (Phase 2,
 * useBotPageOpen) and reads it; opening the item from anywhere else reads it
 * too (the activity PATCH `opened`). A failed run's notice (the alert) sits
 * here, unread, until you open it. "Mark all read" (while any is unread) reads
 * every one of this bot's, for you only (POST /notifications/bot/mark-all-read).
 *
 * A bot you can't reach (the roster's `reachable` isn't `true`) has no part:
 * the route refuses it, and nothing of it is drawn.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCheck, ChevronRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { Notification } from '@/app/account/notification-context'
import { useBotNotices } from '@/hooks/use-bot-notices'
import { relativeTime } from '@/lib/work/presentation'
import { cn } from '@/lib/utils'
import { noticeText, noticeWorkItemId } from '@/lib/bots/bot-notice'
import { BotPageCard, BotPageEmpty } from './bot-page-card'

/** How many of its newest notices the page lists, and how many more each "Show more" adds. */
export const PAGE_NOTICES_LIMIT = 30
/** The most the page lists (the route's own cap). */
export const PAGE_NOTICES_MAX = 200

export function Notices({
  teammateId,
  name,
  reachable,
  onOpen,
}: {
  teammateId: string
  name: string
  /** You may reach it (the roster's word, `=== true`): otherwise no part at all. */
  reachable: boolean
  /** A notice clicked: its item (it's read by then). */
  onOpen: (notice: Notification, workItemId: string) => void
}) {
  const [limit, setLimit] = useState(PAGE_NOTICES_LIMIT)
  const { notices, unread, failed, read, markAllRead } = useBotNotices(reachable ? teammateId : null, { limit })
  if (!reachable) return null
  // A full page may have more behind it.
  const more = !!notices && notices.length >= limit && limit < PAGE_NOTICES_MAX
  return (
    <BotPageCard
      section="notices"
      title="Notices"
      count={unread}
      hint="Newest first; read when its item opens"
      bounded
      action={
        unread > 0 ? (
          <button
            type="button"
            data-bot-page-notices-mark-all=""
            onClick={() => void markAllRead()}
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <CheckCheck aria-hidden className="h-3 w-3" />
            Mark all read
          </button>
        ) : undefined
      }
    >
      {notices === null ? (
        failed ? (
          <BotPageEmpty>Couldn’t load {name}’s notices.</BotPageEmpty>
        ) : (
          <div data-bot-page-notices-loading="" className="space-y-1.5 px-1.5 pb-1">
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        )
      ) : notices.length === 0 ? (
        <BotPageEmpty>No notices from {name}.</BotPageEmpty>
      ) : (
        <ul data-bot-page-notices="" className="space-y-1.5">
          {notices.map((notice) => {
            const item = noticeWorkItemId(notice)
            return (
              <NoticeRow
                key={notice.id}
                notice={notice}
                onOpen={
                  item
                    ? () => {
                        read(notice.id)
                        onOpen(notice, item)
                      }
                    : notice.is_read
                      ? undefined
                      : () => read(notice.id)
                }
              />
            )
          })}
          {more && (
            <li>
              <button
                type="button"
                data-bot-page-notices-more=""
                onClick={() => setLimit((l) => Math.min(PAGE_NOTICES_MAX, l + PAGE_NOTICES_LIMIT))}
                className="w-full rounded-lg px-2.5 py-1.5 text-center text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                Show more
              </button>
            </li>
          )}
        </ul>
      )}
    </BotPageCard>
  )
}

/** One notice: what the bot said, when, a dot while it's unread; it opens its item. */
function NoticeRow({ notice, onOpen }: { notice: Notification; onOpen?: () => void }) {
  const failure = notice.type === 'work_failed'
  const unread = !notice.is_read
  return (
    <li data-bot-page-notice={notice.id} data-bot-page-notice-unread={unread || undefined} className="rounded-lg border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className={cn('flex w-full min-w-0 items-start gap-2.5 px-2.5 py-2 text-left', !onOpen && 'cursor-default')}
      >
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center">
          {failure ? (
            <AlertTriangle className={cn('h-3.5 w-3.5', unread ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70')} />
          ) : (
            <span className={cn('h-1.5 w-1.5 rounded-full', unread ? 'bg-amber-500 dark:bg-amber-400' : 'bg-transparent')} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('line-clamp-3 text-xs leading-[17px]', unread ? 'font-medium text-foreground' : 'text-muted-foreground')}>
            {(unread || failure) && <span className="sr-only">{[unread ? 'Unread' : null, failure ? 'couldn’t finish' : null].filter(Boolean).join(', ')}: </span>}
            {noticeText(notice)}
          </p>
        </div>
        <span className="shrink-0 pt-px text-[10px] tabular-nums text-muted-foreground">{relativeTime(notice.created_at)}</span>
        {onOpen && <ChevronRight aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
      </button>
    </li>
  )
}
