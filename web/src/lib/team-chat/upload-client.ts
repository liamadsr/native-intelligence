'use client'

/**
 * Team chat's files from the page (migration 558): an upload goes straight to
 * the private team-chat-files bucket as the person (558's policy lets them
 * write only into their own sub-folder of a channel they may post in), and
 * a link to a file is signed as the person too (only the channel's readers
 * get one). Links are cached until a little before they run out, and the
 * paths a list of messages needs at once are signed in one request.
 */
import { createClient } from '@/lib/supabase/client'
import {
  TEAM_CHAT_FILE_URL_TTL_SECONDS,
  TEAM_CHAT_FILES_BUCKET,
  isInlineImage,
  teamChatFilePath,
  teamChatFileType,
  validateTeamChatFile,
} from './files'
import type { TeamChatAttachment } from './types'

export class TeamChatUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamChatUploadError'
  }
}

/** An image's own size, px; none for a file that isn't one the browser can read. */
async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null
  }
}

/** Upload one file into the channel's folder, the person's sub-folder: the attachment the message will carry. */
export async function uploadTeamChatFile(channelId: string, file: File): Promise<TeamChatAttachment> {
  const check = validateTeamChatFile(file)
  if (!check.ok) throw new TeamChatUploadError(check.reason)
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) throw new TeamChatUploadError('You need to be signed in to share files.')
  const path = teamChatFilePath(channelId, userId, file.name)
  const type = teamChatFileType(file.name) ?? 'application/octet-stream'
  const { error } = await supabase.storage.from(TEAM_CHAT_FILES_BUCKET).upload(path, file, { contentType: type, upsert: false })
  if (error) throw new TeamChatUploadError('That file didn’t upload. Try again.')
  const size = isInlineImage({ path }) ? await imageSize(file) : null
  return { path, name: file.name.slice(0, 200), size: file.size, type, ...(size ?? {}) }
}

/** Take back an upload that was never sent (the person's own; never throws). */
export async function discardTeamChatFile(path: string): Promise<void> {
  try {
    await createClient().storage.from(TEAM_CHAT_FILES_BUCKET).remove([path])
  } catch {
    // Left behind: an object no message points at.
  }
}

/** Links signed, until a minute before they run out. */
const cache = new Map<string, { url: string; until: number }>()
let queued: Map<string, Array<(url: string | null) => void>> | null = null

async function signQueued(batch: Map<string, Array<(url: string | null) => void>>) {
  const paths = [...batch.keys()]
  let urls: Record<string, string> = {}
  try {
    const { data } = await createClient().storage.from(TEAM_CHAT_FILES_BUCKET).createSignedUrls(paths, TEAM_CHAT_FILE_URL_TTL_SECONDS)
    for (const entry of data ?? []) if (entry.path && entry.signedUrl && !entry.error) urls[entry.path] = entry.signedUrl
  } catch {
    urls = {}
  }
  const until = Date.now() + (TEAM_CHAT_FILE_URL_TTL_SECONDS - 60) * 1000
  for (const [path, waiting] of batch) {
    const url = urls[path] ?? null
    if (url) cache.set(path, { url, until })
    for (const resolve of waiting) resolve(url)
  }
}

/** A link to a file the person may read (null when they may not, or it is gone). Paths asked for together are signed in one request. */
export function teamChatFileUrl(path: string, now: number = Date.now()): Promise<string | null> {
  const hit = cache.get(path)
  if (hit && hit.until > now) return Promise.resolve(hit.url)
  return new Promise((resolve) => {
    if (!queued) {
      const batch = new Map<string, Array<(url: string | null) => void>>()
      queued = batch
      setTimeout(() => {
        queued = null
        void signQueued(batch)
      }, 0)
    }
    const waiting = queued.get(path) ?? []
    waiting.push(resolve)
    queued.set(path, waiting)
  })
}

/** A link already signed and still good, or null (the page draws from it at once, with no flash). */
export function cachedTeamChatFileUrl(path: string, now: number = Date.now()): string | null {
  const hit = cache.get(path)
  return hit && hit.until > now ? hit.url : null
}
