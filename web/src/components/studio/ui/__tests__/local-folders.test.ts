/**
 * Folders on this computer, linked in the Studio's Browser (../local-folders.ts). The server can't read the person's
 * computer, so a folder is listed here, in the page, with what the platform offers. What must hold:
 *   - kinds and what can be added: the importer's own types, an M4V, and stills this page can draw; not AIFF.
 *   - the platform decides how a folder is linked: folder handles (kept across reloads) in Chromium, a folder input
 *     (this visit only) in Safari, Firefox and the desktop app's WebKit view, plain files otherwise.
 *   - a listing reads names, sizes and dates, never a file's contents, and is capped; a cut listing says so.
 *   - search is capped too (matches, items looked through, depth) and stops when a newer search starts.
 *   - persistence: a kept folder's handle is remembered and asks again after a reload; a folder from the input keeps
 *     only its name and shows "choose it again" after a reload, never as still linked.
 * Every browser API is a stand-in: made-up folders, no real disk.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  addable, fileAt, folderSupport, importableFile, indexFiles, kindOf, LIMITS, listLocal, LocalFolderError, LocalFolders, readSaved, searchLocal,
  handleSource, type DirHandleLike, type FileHandleLike, type FileLike, type HandleStore, type LocalDeps,
} from '../local-folders'

// ── Stand-ins ────────────────────────────────────────────────────────────────

type Tree = { [name: string]: Tree | number }
/** A file whose contents may not be read: listing must only look at its size and date. */
const sealed = (name: string, size: number): File => {
  const file = new File([], name, { lastModified: 1_700_000_000_000 })
  Object.defineProperty(file, 'size', { value: size })
  for (const read of ['text', 'arrayBuffer', 'stream', 'bytes'] as const) Object.defineProperty(file, read, { value: () => { throw new Error(`read ${name}`) } })
  return file
}
let handleCalls = 0
function dir(name: string, tree: Tree, permission: PermissionState = 'granted'): DirHandleLike & { permission: PermissionState } {
  const child = (key: string): FileHandleLike | DirHandleLike => {
    const value = tree[key]
    if (value === undefined) throw Object.assign(new Error('gone'), { name: 'NotFoundError' })
    return typeof value === 'number' ? { kind: 'file', name: key, getFile: async () => { handleCalls++; return sealed(key, value) } } : dir(key, value, permission)
  }
  const self = {
    kind: 'directory' as const, name, permission,
    async *entries() { for (const key of Object.keys(tree)) yield [key, child(key)] as [string, FileHandleLike | DirHandleLike] },
    getDirectoryHandle: async (key: string) => { const h = child(key); if (h.kind !== 'directory') throw Object.assign(new Error('not a folder'), { name: 'TypeMismatchError' }); return h },
    getFileHandle: async (key: string) => { const h = child(key); if (h.kind !== 'file') throw Object.assign(new Error('not a file'), { name: 'TypeMismatchError' }); return h },
    queryPermission: async () => self.permission,
    requestPermission: async () => { self.permission = 'granted'; return self.permission },
    isSameEntry: async (other: DirHandleLike) => other.name === name,
  }
  return self
}
const picked = (paths: Record<string, number>): FileLike[] => Object.entries(paths).map(([path, size]) => {
  const file = sealed(path.split('/').at(-1)!, size) as FileLike
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
})
const trip = new Map<string, DirHandleLike>()
const handleStore = (): HandleStore => ({ get: async id => trip.get(id), put: async (id, h) => { trip.set(id, h) }, delete: async id => { trip.delete(id) } })
function memory() { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } } }
let ids = 0
function deps(over: Partial<LocalDeps> = {}): LocalDeps {
  return { storage: memory(), handles: handleStore(), support: () => 'kept', pickDirectory: async () => null, pickFiles: async () => null, newId: () => `id-${++ids}`, ...over }
}
const HOLIDAY: Tree = { 'clip 10.mp4': 4_000_000, 'clip 2.mp4': 3_000_000, '.DS_Store': 10, stills: { 'beach.heic': 2_000_000, 'map.png': 120_000 }, 'Music': { 'theme.wav': 9_000_000 }, 'notes.md': 300 }

// ── Kinds ────────────────────────────────────────────────────────────────────

describe('kinds', () => {
  it('names each file by its extension', () => {
    expect(['a.MOV', 'b.png', 'c.flac', 'd.woff2', 'e.pdf', 'f.xyz', 'noext'].map(kindOf)).toEqual(['video', 'image', 'audio', 'font', 'document', 'other', 'other'])
  })
  it('can add what the importer takes, an M4V, and stills this page can draw; not AIFF or documents', () => {
    expect(['a.mp4', 'b.m4v', 'c.heic', 'd.svg', 'e.wav', 'f.aiff', 'g.pdf'].map(addable)).toEqual([true, true, true, true, true, false, false])
  })
})

// ── How a folder can be linked here ─────────────────────────────────────────

describe('folderSupport', () => {
  const input = (folders: boolean) => ({ prototype: folders ? { webkitdirectory: false } : {} })
  it('keeps the link where the page has folder handles and IndexedDB (Chromium)', () => {
    expect(folderSupport({ showDirectoryPicker: () => {}, indexedDB: {}, isSecureContext: true, HTMLInputElement: input(true) })).toBe('kept')
  })
  it('links for this visit with a folder input (Safari, Firefox, the desktop app)', () => {
    expect(folderSupport({ indexedDB: {}, HTMLInputElement: input(true) })).toBe('session')
    // Folder handles on an insecure page can't be used.
    expect(folderSupport({ showDirectoryPicker: () => {}, indexedDB: {}, isSecureContext: false, HTMLInputElement: input(true) })).toBe('session')
  })
  it('falls back to picking files when the input takes no folders', () => {
    expect(folderSupport({ HTMLInputElement: input(false) })).toBe('files')
  })
})

// ── Listing ──────────────────────────────────────────────────────────────────

describe('a folder input’s files', () => {
  it('become folders and files by path, folders first, in natural order, hidden files left out', () => {
    const index = indexFiles(picked({ 'Holiday/clip 10.mp4': 4, 'Holiday/clip 2.mp4': 3, 'Holiday/.DS_Store': 1, 'Holiday/stills/map.png': 2, 'Holiday/.cache/x.png': 5 }))
    expect(index.root).toBe('Holiday')
    expect(index.count).toBe(3)
    expect(index.dirs.get('')!.map(e => `${e.kind}:${e.name}`)).toEqual(['folder:stills', 'video:clip 2.mp4', 'video:clip 10.mp4'])
    expect(index.dirs.get('stills')![0]).toMatchObject({ name: 'map.png', path: 'stills/map.png', kind: 'image', size: 2, addable: true })
  })
  it('files picked one by one (no folder) are one flat place', () => {
    const plain = [sealed('one.mp3', 1), sealed('two.png', 2)] as FileLike[]
    const index = indexFiles(plain)
    expect(index.root).toBeNull()
    expect(index.dirs.get('')!.map(e => e.path)).toEqual(['one.mp3', 'two.png'])
  })
  it('a long folder is cut at the cap and says how many it holds', async () => {
    const many: Record<string, number> = {}
    for (let i = 0; i < 12; i++) many[`Big/take ${i}.mp4`] = i + 1
    const listing = await listLocal({ type: 'files', index: indexFiles(picked(many)) }, '', { ...LIMITS, folder: 5 })
    expect(listing.entries).toHaveLength(5)
    expect(listing).toMatchObject({ truncated: true, total: 12 })
  })
})

describe('a folder handle', () => {
  it('lists one level, folders first, with sizes, never reading a file', async () => {
    const listing = await listLocal(handleSource(dir('Holiday', HOLIDAY)), '')
    expect(listing.entries.map(e => e.name)).toEqual(['Music', 'stills', 'clip 2.mp4', 'clip 10.mp4', 'notes.md'])
    expect(listing.entries.find(e => e.name === 'clip 2.mp4')).toMatchObject({ kind: 'video', size: 3_000_000, addable: true })
    expect(listing).toMatchObject({ truncated: false, total: 5 })
    const inner = await listLocal(handleSource(dir('Holiday', HOLIDAY)), 'stills')
    expect(inner.entries.map(e => `${e.path}:${e.addable}`)).toEqual(['stills/beach.heic:true', 'stills/map.png:true'])
  })
  it('stops counting a huge folder and shows only the first items', async () => {
    const huge: Tree = {}
    for (let i = 0; i < 60; i++) huge[`frame ${i}.png`] = 10
    handleCalls = 0
    const listing = await listLocal(handleSource(dir('Frames', huge)), '', { ...LIMITS, folder: 10, names: 25 })
    expect(listing.entries).toHaveLength(10)
    expect(listing).toMatchObject({ truncated: true, total: null })
    // Sizes are looked up for the rows shown, not for every name.
    expect(handleCalls).toBe(10)
  })
  it('a folder that is gone says so', async () => {
    await expect(listLocal(handleSource(dir('Holiday', HOLIDAY)), 'Elsewhere')).rejects.toBeInstanceOf(LocalFolderError)
    await expect(fileAt(handleSource(dir('Holiday', HOLIDAY)), 'stills/gone.png')).rejects.toMatchObject({ reason: 'missing' })
  })
  it('hands over a file to preview or add', async () => {
    const file = await fileAt(handleSource(dir('Holiday', HOLIDAY)), 'Music/theme.wav')
    expect(file).toMatchObject({ name: 'theme.wav', size: 9_000_000 })
  })
})

// ── Search ───────────────────────────────────────────────────────────────────

describe('searchLocal', () => {
  const deep: Tree = { a: { b: { c: { d: { 'deep beach.png': 1 } } } }, 'beach 1.mp4': 5, 'beach 2.mp4': 6, 'beach day.wav': 7, misc: { 'beach map.png': 8 } }
  it('finds every word, in a kind when asked, with sizes', async () => {
    const all = await searchLocal(handleSource(dir('Trip', deep)), 'beach')
    expect(all.results.map(r => r.path)).toEqual(['a/b/c/d/deep beach.png', 'beach 1.mp4', 'beach 2.mp4', 'beach day.wav', 'misc/beach map.png'].sort((x, y) => x.split('/').at(-1)!.localeCompare(y.split('/').at(-1)!, undefined, { numeric: true })))
    expect(all.truncated).toBe(false)
    const maps = await searchLocal(handleSource(dir('Trip', deep)), 'misc beach', { kind: 'image' })
    expect(maps.results).toEqual([expect.objectContaining({ path: 'misc/beach map.png', size: 8 })])
  })
  it('stops at its caps and says so', async () => {
    expect(await searchLocal(handleSource(dir('Trip', deep)), 'beach', { limits: { ...LIMITS, results: 2 } })).toMatchObject({ truncated: true, results: [expect.anything(), expect.anything()] })
    const shallow = await searchLocal(handleSource(dir('Trip', deep)), 'deep', { limits: { ...LIMITS, depth: 2 } })
    expect(shallow).toEqual({ results: [], truncated: true })
    expect((await searchLocal(handleSource(dir('Trip', deep)), 'beach', { limits: { ...LIMITS, visited: 3 } })).truncated).toBe(true)
  })
  it('a newer search stops an older one', async () => {
    const stop = new AbortController(); stop.abort()
    expect(await searchLocal(handleSource(dir('Trip', deep)), 'beach', { signal: stop.signal })).toEqual({ results: [], truncated: false })
  })
  it('searches a folder input’s files the same way', async () => {
    const source = { type: 'files' as const, index: indexFiles(picked({ 'Trip/beach 1.mp4': 1, 'Trip/misc/beach map.png': 2, 'Trip/misc/other.png': 3 })) }
    expect((await searchLocal(source, 'beach', { kind: 'image' })).results.map(r => r.path)).toEqual(['misc/beach map.png'])
  })
})

// ── Getting a file ready to add ──────────────────────────────────────────────

describe('importableFile', () => {
  it('passes the importer’s own types through as they are', async () => {
    const clip = sealed('take.mov', 10)
    expect(await importableFile(clip)).toBe(clip)
  })
  it('names an M4V as the MP4 it is, without reading it', async () => {
    const out = await importableFile(sealed('take.m4v', 10))
    expect(out).toMatchObject({ name: 'take.mp4', type: 'video/mp4' })
  })
  it('turns other stills into a picture the importer takes, and refuses what it can’t add', async () => {
    const convert = vi.fn(async (f: File) => new File([], f.name.replace(/\.\w+$/, '.jpg')))
    expect((await importableFile(sealed('beach.heic', 1), convert)).name).toBe('beach.jpg')
    await expect(importableFile(sealed('theme.aiff', 1), convert)).rejects.toThrow('WAV, MP3 or M4A')
    await expect(importableFile(sealed('notes.md', 1), convert)).rejects.toThrow('can be previewed but not added')
  })
})

// ── Linking, and what is kept ────────────────────────────────────────────────

describe('LocalFolders', () => {
  it('a Chromium folder is kept: its handle is remembered, and after a reload the browser asks once', async () => {
    const storage = memory(), folder = dir('Holiday', HOLIDAY, 'granted')
    const first = new LocalFolders(deps({ storage, pickDirectory: async () => folder }))
    await first.start()
    const linked = await first.add()
    expect(linked).toMatchObject({ existing: false })
    expect(first.places()).toEqual([{ id: linked!.id, name: 'Holiday', mode: 'kept', status: 'ready' }])
    expect(readSaved(storage)).toEqual([{ id: linked!.id, name: 'Holiday', mode: 'kept' }])
    expect((await first.listFolder(linked!.id, '')).entries).toHaveLength(5)

    // The page reloads: the browser wants the person's OK again.
    folder.permission = 'prompt'
    const second = new LocalFolders(deps({ storage }))
    await second.start()
    expect(second.place(linked!.id)?.status).toBe('ask')
    await expect(second.listFolder(linked!.id, '')).rejects.toBeInstanceOf(LocalFolderError)
    expect(await second.allow(linked!.id)).toBe(true)
    expect(second.place(linked!.id)?.status).toBe('ready')
    expect((await second.listFolder(linked!.id, '')).entries.length).toBe(5)
  })

  it('a kept folder the browser still allows opens at once; one whose handle is gone is missing', async () => {
    const storage = memory()
    const store = new LocalFolders(deps({ storage, pickDirectory: async () => dir('Allowed', { 'a.png': 1 }, 'granted') }))
    await store.start(); const kept = await store.add()
    const again = new LocalFolders(deps({ storage })); await again.start()
    expect(again.place(kept!.id)?.status).toBe('ready')
    trip.delete(kept!.id)
    const later = new LocalFolders(deps({ storage })); await later.start()
    expect(later.place(kept!.id)?.status).toBe('missing')
  })

  it('the same folder twice opens the one already linked', async () => {
    const store = new LocalFolders(deps({ pickDirectory: async () => dir('Holiday', HOLIDAY) }))
    await store.start()
    const one = await store.add(), two = await store.add()
    expect(two).toEqual({ id: one!.id, existing: true })
    expect(store.places()).toHaveLength(1)
  })

  it('a folder input’s folder is linked for this visit; after a reload it waits to be chosen again', async () => {
    const storage = memory()
    const first = new LocalFolders(deps({ storage, support: () => 'session', pickFiles: async folders => folders ? picked({ 'Holiday/clip 2.mp4': 3, 'Holiday/stills/map.png': 2 }) : null }))
    await first.start()
    const linked = await first.add()
    expect(first.place(linked!.id)).toMatchObject({ name: 'Holiday', mode: 'session', status: 'ready' })
    expect((await first.listFolder(linked!.id, '')).entries.map(e => e.name)).toEqual(['stills', 'clip 2.mp4'])
    expect(readSaved(storage)).toEqual([{ id: linked!.id, name: 'Holiday', mode: 'session' }])

    // Reloaded: only the name is left. It is not shown as linked, and its files can't be reached.
    const pickFiles = vi.fn(async () => picked({ 'Holiday/clip 3.mp4': 4 }))
    const second = new LocalFolders(deps({ storage, support: () => 'session', pickFiles }))
    await second.start()
    expect(second.place(linked!.id)?.status).toBe('choose-again')
    await expect(second.file(linked!.id, 'clip 2.mp4')).rejects.toMatchObject({ reason: 'missing' })
    expect(await second.chooseAgain(linked!.id)).toEqual({ id: linked!.id, existing: true })
    expect(pickFiles).toHaveBeenCalledWith(true)
    expect(second.place(linked!.id)?.status).toBe('ready')
    expect((await second.listFolder(linked!.id, '')).entries.map(e => e.name)).toEqual(['clip 3.mp4'])
  })

  it('choosing a folder of the same name after a reload takes the place waiting for it', async () => {
    const storage = memory(), files = async () => picked({ 'Holiday/a.png': 1 })
    const first = new LocalFolders(deps({ storage, support: () => 'session', pickFiles: files }))
    await first.start(); const linked = await first.add()
    const second = new LocalFolders(deps({ storage, support: () => 'session', pickFiles: files }))
    await second.start()
    expect(await second.add()).toEqual({ id: linked!.id, existing: true })
    expect(second.places()).toHaveLength(1)
  })

  it('an empty folder from the input can’t be linked (the page is not even told its name)', async () => {
    const store = new LocalFolders(deps({ support: () => 'session', pickFiles: async () => [] }))
    await store.start()
    await expect(store.add()).rejects.toThrow('nothing to link')
    expect(store.places()).toEqual([])
  })

  it('files picked one by one, where the input takes no folders, are one flat place', async () => {
    const pickFiles = vi.fn(async () => [sealed('one.mp3', 1)] as FileLike[])
    const store = new LocalFolders(deps({ support: () => 'files', pickFiles }))
    await store.start(); const linked = await store.add()
    expect(pickFiles).toHaveBeenCalledWith(false)
    expect(store.place(linked!.id)).toMatchObject({ name: 'Chosen files', mode: 'session', flat: true })
  })

  it('a page that may not use the folder picker uses the folder input instead', async () => {
    const pickFiles = vi.fn(async () => picked({ 'Holiday/a.png': 1 }))
    const store = new LocalFolders(deps({ pickDirectory: async () => { throw Object.assign(new Error('frame'), { name: 'SecurityError' }) }, pickFiles }))
    await store.start()
    expect(await store.add()).toMatchObject({ existing: false })
    expect(store.places()[0]).toMatchObject({ mode: 'session', name: 'Holiday' })
  })

  it('a folder handle the browser can’t keep is linked until the page reloads, and says so', async () => {
    const storage = memory(), handles = { ...handleStore(), put: async () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }) } }
    const store = new LocalFolders(deps({ storage, handles, pickDirectory: async () => dir('Unkept', { 'a.png': 1 }) }))
    await store.start(); const linked = await store.add()
    expect(store.place(linked!.id)).toMatchObject({ mode: 'session', status: 'ready' })
    expect((await store.listFolder(linked!.id, '')).entries).toHaveLength(1)
    const reloaded = new LocalFolders(deps({ storage })); await reloaded.start()
    expect(reloaded.place(linked!.id)?.status).toBe('choose-again')
  })

  it('cancelling links nothing', async () => {
    const storage = memory(), store = new LocalFolders(deps({ storage }))
    await store.start()
    expect(await store.add()).toBeNull()
    expect(readSaved(storage)).toEqual([])
  })

  it('removing forgets the folder and its handle; the folder itself is untouched', async () => {
    const storage = memory(), store = new LocalFolders(deps({ storage, pickDirectory: async () => dir('Removed', { 'a.png': 1 }) }))
    await store.start(); const linked = await store.add()
    expect(trip.has(linked!.id)).toBe(true)
    await store.remove(linked!.id)
    expect(store.places()).toEqual([]); expect(readSaved(storage)).toEqual([]); expect(trip.has(linked!.id)).toBe(false)
  })

  it('a kept folder the browser stops allowing asks again; a gone one is missing', async () => {
    const store = new LocalFolders(deps({ pickDirectory: async () => dir('Holiday', HOLIDAY) }))
    await store.start(); const linked = await store.add()
    store.lost(linked!.id, new LocalFolderError('no', 'permission'))
    expect(store.place(linked!.id)?.status).toBe('ask')
    expect(await store.allow(linked!.id)).toBe(true)
    store.lost(linked!.id, new LocalFolderError('gone', 'missing'))
    expect(store.place(linked!.id)?.status).toBe('missing')
  })

  it('a remembered list that is not ours is ignored', () => {
    const storage = memory()
    storage.setItem('ni:studio:browser.local-folders.v1', JSON.stringify([{ id: 'library', name: 'x', mode: 'kept' }, { id: 'local:1', name: 'Ok', mode: 'session' }, 'junk']))
    expect(readSaved(storage)).toEqual([{ id: 'local:1', name: 'Ok', mode: 'session' }])
    storage.setItem('ni:studio:browser.local-folders.v1', '{not json')
    expect(readSaved(storage)).toEqual([])
  })
})
