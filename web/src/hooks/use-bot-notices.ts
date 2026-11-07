'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNotifications, type Notification } from '@/app/account/notification-context'
import { noticeTeammateId } from '@/lib/bots/bot-notice'
import { noticeSpeakerOf } from '@/lib/bots/notice-faces'

/**
 * One bot's notices, for its Notices part (docs/plans/bots-v4.md Phase 4c,
 * decision 8: a bot's notices live with the bot, in its bubble and on its
 * page): GET /api/account/notifications/bot.
 *
 * It loads while a consumer is drawn: pass the teammate's id then, and null
 * otherwise (nothing loads, nothing is held). Pass null too for a bot you
 * can't reach (the roster's `reachable` isn't `true`): the route would answer
 * 404 for it anyway.
 *
 * Live without a channel of its own: the window's notification channel holds
 * the bots' notices it hears (NotificationProvider `botNotices`, the active
 * workspace's, or every one's with "Show all workspaces" on). When one of this
 * bot's lands, is read (its item opened anywhere, BOT_NOTICES_REREAD_MS later)
 * or goes, the list is read again; meanwhile the held copy's read state shows
 * at once. A bot in a workspace the channel doesn't hear catches up when its
 * part opens again (the bubble's, or the page's lists coming back from an
 * item).
 *
 * Read here at once: a notice clicked (`read`: the provider's markAsRead,
 * PATCH /notifications/[id]) stays read here until an answer says so too, so a
 * read again that started before the PATCH landed never shows it unread a
 * moment. "Mark all read" (`markAllRead`: POST
 * /notifications/bot/mark-all-read) shows every one read, and the count none,
 * until the answer read after it lands.
 *
 * A 400, 403 or 404 is final (not a teammate you may read): it holds nothing.
 * Any other failure says so (`failed`) and keeps what it held.
 */
export const BOT_NOTICES_URL = '/api/account/notifications/bot'
export const BOT_NOTICES_MARK_ALL_URL = '/api/account/notifications/bot/mark-all-read'
/** How long after one of its notices moves the list is read again (several moves at once read once). */
export const BOT_NOTICES_REREAD_MS = 300
/** Answers that say it isn't a teammate you can read: final, and nothing is held. */
const NOT_YOURS = new Set([400, 403, 404])

export interface BotNoticesOptions {
  /** How many, newest first (the route's default when absent). */
  limit?: number
  /** Only the unread ones (the bubble's part). */
  unreadOnly?: boolean
  /** Work items whose notices are left out of the list and the count (the bubble's own items). */
  exceptItems?: readonly string[]
}

export interface BotNotices {
  /** Its notices, newest first; null until the first answer for this bot. With `unreadOnly`, a notice read since leaves. */
  notices: Notification[] | null
  /** How many of its notices are unread in all (the route's count, less the ones read here since). */
  unread: number
  /** The last read failed. */
  failed: boolean
  /** A notice was clicked: it's read now, here and on the server. */
  read: (id: string) => void
  /** Every notice of this bot read, here at once and on the server (its page's "Mark all read"). */
  markAllRead: () => Promise<void>
}

/** The route for one bot's notices. */
export function botNoticesUrl(teammateId: string, opts: BotNoticesOptions = {}): string {
  const params = new URLSearchParams({ teammate: teammateId })
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.unreadOnly) params.set('unread_only', '1')
  const except = [...new Set(opts.exceptItems ?? [])].sort()
  if (except.length > 0) params.set('except_items', except.join(','))
  return `${BOT_NOTICES_URL}?${params.toString()}`
}

interface Held {
  url: string
  /** Whose: an answer for the same bot stands while another of its reads (more of them, another bubble's items) loads. */
  teammateId: string
  notices: Notification[]
  unread: number
}

export function useBotNotices(teammateId: string | null, opts: BotNoticesOptions = {}): BotNotices {
  const { botNotices, markAsRead } = useNotifications()
  const url = teammateId ? botNoticesUrl(teammateId, opts) : null
  const [held, setHeld] = useState<Held | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // Clicked here, until an answer has them read too.
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(() => new Set())
  // "Mark all read" pressed: everything read here until the answer read after it.
  const [allRead, setAllRead] = useState(false)
  const allReadFrom = useRef<number | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (asked: string, whose: string) => {
    const mine = ++seq.current
    try {
      const res = await fetch(asked, { cache: 'no-store' })
      if (mine !== seq.current) return
      if (res.ok) {
        const data = (await res.json()) as { notices?: Notification[]; unread?: number }
        if (mine !== seq.current) return
        const notices = Array.isArray(data.notices) ? data.notices : []
        setHeld({ url: asked, teammateId: whose, notices, unread: typeof data.unread === 'number' ? data.unread : 0 })
        // Kept only while this answer still has them unread (the PATCH not landed yet).
        setReadHere((had) => {
          if (had.size === 0) return had
          const still = new Set([...had].filter((id) => notices.some((n) => n.id === id && !n.is_read)))
          return still.size === had.size ? had : still
        })
        if (allReadFrom.current !== null && mine >= allReadFrom.current) {
          allReadFrom.current = null
          setAllRead(false)
        }
        setFailedUrl(null)
        return
      }
      if (NOT_YOURS.has(res.status)) {
        setHeld({ url: asked, teammateId: whose, notices: [], unread: 0 })
        setFailedUrl(null)
        return
      }
      setFailedUrl(asked)
    } catch {
      if (mine === seq.current) setFailedUrl(asked)
    }
  }, [])

  // This bot's notices as the window's channel holds them, and what moves them
  // (one face: the agent's include its workspace's area faces', as its route
  // reads them; who an area face speaks as is what the crew published from
  // the roster, notice-faces.ts noticeSpeakerOf).
  const live = useMemo(
    () =>
      teammateId
        ? botNotices.filter((n) => {
            const named = noticeTeammateId(n.metadata)
            return !!named && (noticeSpeakerOf(named)?.teammateId ?? named) === teammateId
          })
        : [],
    [botNotices, teammateId],
  )
  const liveKey = live.map((n) => `${n.id}:${n.is_read ? 1 : 0}:${n.is_archived ? 1 : 0}`).join(',')
  // The key the last read began from: a move after it reads again.
  const readFrom = useRef<string | null>(null)

  useEffect(() => {
    if (!url) {
      seq.current += 1
      return
    }
    readFrom.current = liveKey
    void load(url, teammateId!)
    return () => {
      seq.current += 1
    }
    // Read again for another bot or options; a move is the effect below's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, load])

  useEffect(() => {
    if (!url || readFrom.current === liveKey) return
    const timer = setTimeout(() => {
      readFrom.current = liveKey
      void load(url, teammateId!)
    }, BOT_NOTICES_REREAD_MS)
    return () => clearTimeout(timer)
  }, [url, liveKey, load, teammateId])

  const read = useCallback(
    (id: string) => {
      setReadHere((had) => (had.has(id) ? had : new Set([...had, id])))
      void markAsRead(id)
    },
    [markAsRead],
  )

  const latest = useRef({ teammateId, url })
  latest.current = { teammateId, url }
  const markAllRead = useCallback(async () => {
    const { teammateId: id, url: asked } = latest.current
    if (!id || !asked) return
    setAllRead(true)
    // No answer ends it until the one read after the POST.
    allReadFrom.current = Number.POSITIVE_INFINITY
    try {
      await fetch(BOT_NOTICES_MARK_ALL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teammate: id }),
      })
    } catch {
      // The read after it says how it went.
    }
    allReadFrom.current = seq.current + 1
    if (latest.current.url === asked) void load(asked, id)
  }, [load])

  const current = held && teammateId && held.teammateId === teammateId ? held : null
  const shown = useMemo(() => {
    if (!current) return null
    const byId = new Map(live.map((n) => [n.id, n]))
    const out: Notification[] = []
    for (const n of current.notices) {
      const heard = byId.get(n.id)
      if (heard?.is_archived) continue
      const isRead = n.is_read || allRead || !!heard?.is_read || readHere.has(n.id)
      if (opts.unreadOnly && isRead) continue
      out.push(isRead === n.is_read ? n : { ...n, is_read: true, read_at: heard?.read_at ?? n.read_at ?? new Date().toISOString() })
    }
    return out
  }, [current, live, readHere, allRead, opts.unreadOnly])
  // The route's count, less the ones it held unread that are read now.
  const unread = useMemo(() => {
    if (!current || allRead) return 0
    const byId = new Map(live.map((n) => [n.id, n]))
    const readSince = current.notices.filter((n) => !n.is_read && (!!byId.get(n.id)?.is_read || !!byId.get(n.id)?.is_archived || readHere.has(n.id))).length
    return Math.max(0, current.unread - readSince)
  }, [current, live, readHere, allRead])

  return { notices: shown, unread, failed: !!url && failedUrl === url, read, markAllRead }
}
