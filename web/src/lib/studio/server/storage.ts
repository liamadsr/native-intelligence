// The Studio's storage: the private `studio` bucket (migration 620). Nobody reaches it directly; the app signs
// every upload and read after checking the person's workspace, and the worker gets links for the job it holds.
// This is the only file that talks to Supabase Storage, behind a small interface, so the rest (blobs.ts) can be
// tested with a fake.
import type { SupabaseClient } from '@supabase/supabase-js'
import { storeError } from './errors'

export const STUDIO_BUCKET = 'studio'

/** A link that takes one PUT of a part's bytes, with these headers. */
export type SignedUpload = { url: string; headers: Record<string, string> }

export type StudioStorage = {
  /**
   * A link to upload one object. Valid about two hours, and good for more than one PUT until then (storage checks the
   * token, it does not use it up). With `upsert` (the default) a PUT replaces what is there; without, storage refuses
   * a PUT over a stored object (KeyAlreadyExists), and a PUT after the object was removed stores it again.
   */
  signUpload(path: string, contentType: string, options?: { upsert?: boolean }): Promise<SignedUpload>
  /** Links to read objects, in the order asked, valid `seconds`. `download` makes the browser save it under that name. */
  signRead(paths: string[], seconds: number, download?: string): Promise<string[]>
  /** The objects directly under a folder, with their sizes (every one, however many: listed a page at a time). */
  list(folder: string): Promise<{ name: string; size: number }[]>
  /** Remove objects (missing ones are fine): at most 1000 a call, as storage's delete route takes (removeAll sends more). */
  remove(paths: string[]): Promise<void>
  /** Store bytes the app holds itself (a generated canvas): one object. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** The first `bytes` bytes of an object (fewer when it is shorter), to check what a file is. */
  head(path: string, bytes: number): Promise<Uint8Array>
  /** An object's length in bytes, or null when there is none. */
  size(path: string): Promise<number | null>
  /** The folders directly under a folder ('' for the bucket's top), by name. */
  folders(folder: string): Promise<string[]>
}

/** How many objects one remove call sends (storage's delete route takes at most 1000). */
export const REMOVE_BATCH = 500

/** Remove any number of objects, REMOVE_BATCH a call. */
export async function removeAll(storage: Pick<StudioStorage, 'remove'>, paths: string[]): Promise<void> {
  for (let at = 0; at < paths.length; at += REMOVE_BATCH) await storage.remove(paths.slice(at, at + REMOVE_BATCH))
}

/** True for storage's "no such object" answer. */
const notFound = (error: { message?: string; status?: number; statusCode?: string } | null | undefined) =>
  !!error && (error.status === 404 || error.statusCode === '404' || /not.?found/i.test(error.message ?? ''))

/** How many objects one storage listing answers at most (Supabase Storage's own page size). */
export const LIST_PAGE = 1000

/** Read at most `max` bytes of a stream, then let it go. */
async function firstBytes(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader()
  const out = new Uint8Array(max)
  let at = 0
  try {
    while (at < max) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(value.byteLength, max - at)
      out.set(value.subarray(0, take), at)
      at += take
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return out.subarray(0, at)
}

/** The `studio` bucket through a service-role client. */
export function supabaseStorage(supabase: SupabaseClient): StudioStorage {
  const bucket = () => supabase.storage.from(STUDIO_BUCKET)
  return {
    async signUpload(path, contentType, options) {
      const upsert = options?.upsert !== false
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert })
      if (error || !data) {
        console.error('[studio] sign upload failed:', error?.message)
        throw storeError('prepare the upload')
      }
      // The token carries `upsert` (storage reads it from the token, not from a header); the header only repeats it.
      return { url: data.signedUrl, headers: { 'content-type': contentType, 'x-upsert': String(upsert) } }
    },
    async signRead(paths, seconds, download) {
      if (!paths.length) return []
      if (download !== undefined) {
        // One link per call when it carries a file name (a download is one part in practice).
        const out: string[] = []
        for (const path of paths) {
          const { data, error } = await bucket().createSignedUrl(path, seconds, { download })
          if (error || !data) {
            console.error('[studio] sign read failed:', error?.message)
            throw storeError('open that file')
          }
          out.push(data.signedUrl)
        }
        return out
      }
      const { data, error } = await bucket().createSignedUrls(paths, seconds)
      if (error || !data) {
        console.error('[studio] sign reads failed:', error?.message)
        throw storeError('open that file')
      }
      return paths.map((path) => {
        const found = data.find((item) => item.path === path)
        if (!found?.signedUrl) throw storeError('open that file')
        return found.signedUrl
      })
    },
    async list(folder) {
      // A take recorded in pieces can hold thousands of objects under one folder: read every page.
      const out: { name: string; size: number }[] = []
      for (let offset = 0; ; offset += LIST_PAGE) {
        const { data, error } = await bucket().list(folder, { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
        if (error) {
          console.error('[studio] list failed:', error.message)
          throw storeError('check the upload')
        }
        for (const item of data ?? []) {
          if (item.id !== null) out.push({ name: item.name, size: Number((item.metadata as { size?: number } | null)?.size ?? -1) })
        }
        if ((data?.length ?? 0) < LIST_PAGE || offset > 1_000_000) return out
      }
    },
    async size(path) {
      const { data, error } = await bucket().createSignedUrl(path, 60)
      if (notFound(error as never)) return null
      if (error || !data) {
        console.error('[studio] sign read failed:', error?.message)
        throw storeError('check the upload')
      }
      // One byte asked for: storage answers 206 with the whole length in Content-Range ("bytes 0-0/12345").
      const response = await fetch(data.signedUrl, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
      if (!response) throw storeError('check the upload')
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 404 || response.status === 400) return null
      const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? (response.status === 200 ? response.headers.get('content-length') : null)
      if (!response.ok || total === null || total === undefined) throw storeError('check the upload')
      return Number(total)
    },
    async folders(folder) {
      const out: string[] = []
      for (let offset = 0; ; offset += LIST_PAGE) {
        const { data, error } = await bucket().list(folder || undefined, { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
        if (error) {
          console.error('[studio] list failed:', error.message)
          throw storeError('check the upload')
        }
        for (const item of data ?? []) if (item.id === null) out.push(item.name)
        if ((data?.length ?? 0) < LIST_PAGE || offset > 1_000_000) return out
      }
    },
    async head(path, bytes) {
      const { data, error } = await bucket().createSignedUrl(path, 60)
      if (error || !data) {
        console.error('[studio] sign read failed:', error?.message)
        throw storeError('check the upload')
      }
      const response = await fetch(data.signedUrl, { headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
      if (!response?.ok || !response.body) throw storeError('check the upload')
      return firstBytes(response.body, bytes)
    },
    async remove(paths) {
      for (let at = 0; at < paths.length; at += REMOVE_BATCH) {
        const { error } = await bucket().remove(paths.slice(at, at + REMOVE_BATCH))
        if (error) {
          console.error('[studio] remove failed:', error.message)
          throw storeError('remove that file')
        }
      }
    },
    async upload(path, bytes, contentType) {
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: true })
      if (error) {
        console.error('[studio] upload failed:', error.message)
        throw storeError('store that file')
      }
    },
  }
}
