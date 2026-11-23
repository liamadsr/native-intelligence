'use client'

/**
 * The reads behind Drive's Files card (docs/plans/drive-files.md, phase 2),
 * each through its own route and so its own rule:
 *   uploads      GET /api/account/files (the attachments' fences; 709's Drive rule)
 *   team chat    GET /api/account/drive/chat-files (the message's row security)
 *   recent       GET /api/account/drive/opens (the person's own opens)
 *   mail         GET /api/account/drive/mail-files (the person's own mailboxes, live)
 *   members      GET /api/account/workspace/members (for "Created by")
 * Uploads and team chat are read a page at a time each and shown merged,
 * newest first, only as far as no source's next page could come before
 * (lib/drive/drive-items.ts mergeReady).
 */
import * as React from 'react'
import { FILES_OFFSET_MAX, filesUrl, type WorkspaceFile, type WorkspaceFilesPage } from '@/lib/attachments/workspace-files-model'
import type { ChatFilesPage } from '@/lib/drive/chat-files'
import { itemFromChat, itemFromMail, itemFromUpload, mergeReady, type DriveItem } from '@/lib/drive/drive-items'
import type { MailFilesPage } from '@/lib/drive/mail-files'
import type { RecentFile } from '@/lib/drive/opens'

export type DriveTab = 'all' | 'mine' | 'recent' | 'shared'

export interface DriveMember {
  id: string
  user_id: string | null
  display_name: string | null
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error || 'Could not load the files')
  return body
}

/** The workspace's members, for "Created by" (who a file's uploader or sender is). */
export function useDriveMembers(): DriveMember[] {
  const [members, setMembers] = React.useState<DriveMember[]>([])
  React.useEffect(() => {
    let live = true
    getJson<{ members?: DriveMember[] }>('/api/account/workspace/members')
      .then((b) => live && setMembers(Array.isArray(b.members) ? b.members : []))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return members
}

interface SourcePage {
  items: DriveItem[]
  cursor: string | number | null
  more: boolean
}

const EMPTY: SourcePage = { items: [], cursor: null, more: true }
const PAGE = 50
/** How many pages a load reads on its own while nothing shows yet (pages a fence emptied). */
export const DRIVE_AUTO_PAGES_MAX = 5

/** Uploads and team chat files, merged newest first, a page at a time. */
export function useDriveFiles(opts: { tab: Exclude<DriveTab, 'recent'>; uploads: boolean; chat: boolean; q: string; enabled: boolean; reload: number }) {
  const { tab, uploads, chat, q, enabled, reload } = opts
  const [pages, setPages] = React.useState<{ upload: SourcePage; team_chat: SourcePage }>({ upload: EMPTY, team_chat: EMPTY })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const asked = React.useRef(0)
  const pagesRef = React.useRef(pages)
  pagesRef.current = pages

  const readUploads = React.useCallback(
    async (cursor: number): Promise<SourcePage> => {
      const page = await getJson<WorkspaceFilesPage>(filesUrl({ limit: PAGE, offset: cursor, ...(q ? { q } : {}), ...(tab === 'mine' ? { owner: 'mine' } : tab === 'shared' ? { owner: 'others' } : {}) }))
      const next = typeof page.next_offset === 'number' && page.next_offset <= FILES_OFFSET_MAX ? page.next_offset : null
      return { items: page.files.map(itemFromUpload), cursor: next, more: next !== null }
    },
    [q, tab],
  )
  const readChat = React.useCallback(
    async (cursor: string | null): Promise<SourcePage> => {
      const params = new URLSearchParams({ limit: String(PAGE), tab: tab === 'all' ? 'all' : tab })
      if (q) params.set('q', q)
      if (cursor) params.set('before', cursor)
      const page = await getJson<ChatFilesPage>(`/api/account/drive/chat-files?${params}`)
      return { items: page.files.map(itemFromChat), cursor: page.before, more: page.before !== null }
    },
    [q, tab],
  )

  const loadNext = React.useCallback(
    async (fresh: boolean) => {
      const ask = ++asked.current
      setLoading(true)
      setError(null)
      let cur = fresh ? { upload: { ...EMPTY, more: uploads }, team_chat: { ...EMPTY, more: chat } } : pagesRef.current
      try {
        const shown = fresh ? 0 : mergeReady(sources(cur, uploads, chat)).ready.length
        for (let round = 0; round < DRIVE_AUTO_PAGES_MAX; round++) {
          const [u, c] = await Promise.all([
            uploads && cur.upload.more ? readUploads(typeof cur.upload.cursor === 'number' ? cur.upload.cursor : 0) : null,
            chat && cur.team_chat.more ? readChat(typeof cur.team_chat.cursor === 'string' ? cur.team_chat.cursor : null) : null,
          ])
          if (ask !== asked.current) return
          cur = {
            upload: u ? { items: [...cur.upload.items, ...u.items], cursor: u.cursor, more: u.more } : cur.upload,
            team_chat: c ? { items: [...cur.team_chat.items, ...c.items], cursor: c.cursor, more: c.more } : cur.team_chat,
          }
          // Read on while nothing new shows (a page a fence emptied, or held back by the other source) and there is more.
          const left = (uploads && cur.upload.more) || (chat && cur.team_chat.more)
          if (!left || mergeReady(sources(cur, uploads, chat)).ready.length > shown) break
        }
        setPages(cur)
      } catch (err) {
        if (ask === asked.current) setError(err instanceof Error ? err.message : 'Could not load the files')
      } finally {
        if (ask === asked.current) setLoading(false)
      }
    },
    [uploads, chat, readUploads, readChat],
  )

  React.useEffect(() => {
    if (!enabled) return
    void loadNext(true)
  }, [enabled, loadNext, reload])

  const merged = React.useMemo(() => mergeReady(sources(pages, uploads, chat)), [pages, uploads, chat])
  const more = (uploads && pages.upload.more) || (chat && pages.team_chat.more)
  return { items: merged.ready, more, loading, error, loadMore: () => void loadNext(false) }
}

function sources(p: { upload: SourcePage; team_chat: SourcePage }, uploads: boolean, chat: boolean) {
  return [...(uploads ? [{ items: p.upload.items, more: p.upload.more }] : []), ...(chat ? [{ items: p.team_chat.items, more: p.team_chat.more }] : [])]
}

/** The person's recent opens: the files (each still readable), and when each was opened by key. */
export function useRecentFiles(reload: number) {
  const [recent, setRecent] = React.useState<{ items: DriveItem[]; opened: Map<string, string>; loading: boolean; error: string | null }>({ items: [], opened: new Map(), loading: true, error: null })
  React.useEffect(() => {
    let live = true
    getJson<{ files: RecentFile[] }>('/api/account/drive/opens')
      .then((b) => {
        if (!live) return
        const items: DriveItem[] = []
        const opened = new Map<string, string>()
        for (const f of b.files ?? []) {
          const item = f.upload ? itemFromUpload(f.upload) : f.chat ? itemFromChat(f.chat) : null
          if (!item) continue
          item.openedAt = f.openedAt
          opened.set(item.key, f.openedAt)
          items.push(item)
        }
        setRecent({ items, opened, loading: false, error: null })
      })
      .catch((err: unknown) => live && setRecent((r) => ({ ...r, loading: false, error: err instanceof Error ? err.message : 'Could not load the files' })))
    return () => {
      live = false
    }
  }, [reload])
  return recent
}

/** Files attached to the person's own mail, read live, a page at a time. */
export function useMailFiles(q: string, enabled: boolean) {
  const [state, setState] = React.useState<{ items: DriveItem[]; cursor: string | null; mailboxes: number | null; loading: boolean; error: string | null }>({
    items: [],
    cursor: null,
    mailboxes: null,
    loading: false,
    error: null,
  })
  const asked = React.useRef(0)
  const load = React.useCallback(
    async (cursor: string | null) => {
      const ask = ++asked.current
      setState((s) => ({ ...(cursor ? s : { items: [], cursor: null, mailboxes: s.mailboxes }), loading: true, error: null }))
      try {
        const params = new URLSearchParams()
        if (q) params.set('q', q)
        if (cursor) params.set('cursor', cursor)
        const page = await getJson<MailFilesPage>(`/api/account/drive/mail-files${params.size ? `?${params}` : ''}`)
        if (ask !== asked.current) return
        setState((s) => ({ items: [...(cursor ? s.items : []), ...page.files.map(itemFromMail)], cursor: page.cursor, mailboxes: page.mailboxes, loading: false, error: null }))
      } catch (err) {
        if (ask === asked.current) setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'Could not load the files' }))
      }
    },
    [q],
  )
  React.useEffect(() => {
    if (enabled) void load(null)
  }, [enabled, load])
  return { ...state, more: state.cursor !== null, loadMore: () => state.cursor && void load(state.cursor) }
}

/** Record that the person opened a file (an upload or a chat file; never mail). Fire and forget. */
export function recordDriveOpen(item: DriveItem): void {
  const key = item.upload ? `upload:${item.upload.id}` : item.chat ? `team_chat:${item.chat.key}` : null
  if (!key) return
  void fetch('/api/account/drive/opens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {})
}

export type { WorkspaceFile }
