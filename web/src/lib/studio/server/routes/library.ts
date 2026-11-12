// Routes for the editor's Browser (../library.ts): the Studio library and the workspace's own files, in the shapes
// the Browser panel reads. `place` is `library` or `files`; `path` is an asset id or an attachment id (there are
// no folders, so a listing's path is always the top).
//
//   GET  browser/places                      -> { places }
//   GET  browser/list?place&path             -> { place, path, entries, truncated }
//   GET  browser/search?q[&place][&kind]     -> { results, truncated }    (both places when none is named)
//   GET  browser/info?place&path             -> BrowserInfo
//   GET  browser/thumb?place&path            -> 302 to the picture        (images only)
//   GET  browser/file?place&path             -> 302 to the file
//   POST browser/import {place, path}        -> { asset } | { job }        ({ job } while a workspace file's import runs)
//
// A workspace file is read through the person's own client first (the attachments RLS, then its record's), the same
// fence as the Files page; only then is it signed or copied with the service client.
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireWorkspace } from '@/lib/api-auth'
import { notFoundError, StudioError } from '../errors'
import type { StudioContext } from '../context'
import {
  assetInfo, assetLink, fileEntries, fileInfo, fileLink, importLibraryAsset, importWorkspaceFile, libraryAsset, libraryEntries, placeOf, PLACES, visibleFile,
  type BrowserEntry,
} from '../library'
import { route, str, type StudioRoute } from '../router'

/** The person's own client, for the workspace the Studio is open in (the first fence on workspace files). */
async function personClient(ctx: StudioContext): Promise<SupabaseClient> {
  const auth = await requireWorkspace()
  if (auth instanceof Response) throw new StudioError('Sign in again to see the workspace’s files.', 401, 'UNAUTHORIZED')
  if (auth.workspaceId !== ctx.workspaceId) throw notFoundError('That file is not in this workspace.')
  return auth.supabase
}

const tagged = (entries: BrowserEntry[], placeId: string): BrowserEntry[] => {
  const name = placeOf(placeId).name
  return entries.map((entry) => ({ ...entry, placeId, placeName: name }))
}

const redirect = (to: string, base: string) => new Response(null, { status: 302, headers: { location: new URL(to, base).toString(), 'cache-control': 'private, max-age=60' } })

export const libraryRoutes: StudioRoute[] = [
  route('GET', 'browser/places', async () => ({ places: PLACES })),

  route('GET', 'browser/list', async ({ ctx, url }) => {
    const place = placeOf(url.searchParams.get('place'))
    // Places have no folders: anything below the top is empty.
    if (url.searchParams.get('path')) return { place, path: url.searchParams.get('path'), entries: [], truncated: false }
    const entries = place.id === 'library' ? await libraryEntries(ctx) : await fileEntries(await personClient(ctx), ctx.workspaceId)
    return { place, path: '', entries, truncated: false }
  }),

  route('GET', 'browser/search', async ({ ctx, url }) => {
    const q = (url.searchParams.get('q') ?? '').trim()
    const kind = url.searchParams.get('kind')
    const only = url.searchParams.get('place')
    const places = only ? [placeOf(only)] : PLACES
    const results: BrowserEntry[] = []
    for (const place of places) {
      if (place.id === 'library') results.push(...tagged(await libraryEntries(ctx, { q, kind }), place.id))
      else results.push(...tagged(await fileEntries(await personClient(ctx), ctx.workspaceId, { q, kind }), place.id))
    }
    return { results, truncated: false }
  }),

  route('GET', 'browser/info', async ({ ctx, url }) => {
    const place = placeOf(url.searchParams.get('place'))
    const path = url.searchParams.get('path') ?? ''
    if (place.id === 'library') return assetInfo(await libraryAsset(ctx, path))
    return fileInfo(await visibleFile(await personClient(ctx), ctx.workspaceId, path))
  }),

  route('GET', 'browser/thumb', async ({ ctx, url, request }) => {
    const place = placeOf(url.searchParams.get('place'))
    const path = url.searchParams.get('path') ?? ''
    if (place.id === 'library') {
      const asset = await libraryAsset(ctx, path)
      if (asset.kind !== 'image') throw notFoundError('That media has no picture to show.')
      return redirect(assetLink(ctx, asset), request.url)
    }
    const row = await visibleFile(await personClient(ctx), ctx.workspaceId, path)
    return redirect(await fileLink(ctx, row, true), request.url)
  }),

  route('GET', 'browser/file', async ({ ctx, url, request }) => {
    const place = placeOf(url.searchParams.get('place'))
    const path = url.searchParams.get('path') ?? ''
    if (place.id === 'library') return redirect(assetLink(ctx, await libraryAsset(ctx, path)), request.url)
    const row = await visibleFile(await personClient(ctx), ctx.workspaceId, path)
    return redirect(await fileLink(ctx, row), request.url)
  }),

  route('POST', 'browser/import', async ({ ctx, body, request }) => {
    const b = await body()
    const place = placeOf(b.place)
    const path = str(b.path) ?? ''
    if (place.id === 'library') return importLibraryAsset(ctx, path)
    const session = await personClient(ctx)
    return importWorkspaceFile(ctx, session, path, { signal: request.signal })
  }),
]
