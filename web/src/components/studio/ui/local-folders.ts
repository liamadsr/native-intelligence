// Folders on the person's own computer, linked in the Studio's Browser (BrowserPanel.tsx) beside the Studio library
// and the workspace's Files. The Studio's server is remote and cannot read this computer, so a folder is read here, in
// the page, with whatever the platform offers (folderSupport):
//
//   kept      Chromium browsers (Chrome, Edge, Brave, Arc): the folder picker hands a folder handle, kept in this
//             browser's IndexedDB. After a reload the browser asks the person once to let the page read it again
//             (Chrome may offer to allow it on every visit). The listing is live: it reads the folder as it is now.
//   session   Safari, Firefox and the desktop app (a WebKit view, which has no folder handles): a folder input
//             (`webkitdirectory`) hands every file in the folder for as long as the page stays open. Only the folder's
//             name is kept; after a reload it shows as "Choose it again", never as still linked.
//   files     a page whose file input takes no folders: the person picks files, listed as one flat place.
//
// Listing a folder never reads a file's contents: names, sizes and dates only, capped (LIMITS), and a cut listing says
// so. A file's bytes are read only to draw a small thumbnail of a row on screen (local-thumbs.ts), to preview the
// selected file (an object URL, which the browser reads as it plays), or to add it to the video, which uploads it into
// the Studio library through the same upload and import as a file dropped on the editor (client.ts importFile), with
// the server's size and type checks. Nothing leaves this computer before that.
import type { BrowserKind } from './BrowserPanel';

export type LocalMode = 'kept' | 'session';
export type FolderSupport = 'kept' | 'session' | 'files';
/** checking: a kept folder being looked up; ask: the browser needs the person's OK again; choose-again: a folder that
 *  was linked for an earlier visit only; missing: the folder is gone (moved, renamed or deleted) or can't be read. */
export type LocalStatus = 'checking' | 'ready' | 'ask' | 'choose-again' | 'missing';
/** `flat`: files the person picked one by one (no folder), listed together. */
export type LocalPlace = { id: string; name: string; mode: LocalMode; flat?: boolean };
export type LocalPlaceView = LocalPlace & { status: LocalStatus };
export type LocalEntry = { name: string; path: string; kind: BrowserKind; size?: number; modified?: number; addable?: boolean };
/** `total`: how many items the folder holds, when it was counted to the end. */
export type LocalListing = { entries: LocalEntry[]; truncated: boolean; total: number | null };
export type LocalSearch = { results: LocalEntry[]; truncated: boolean };

export const LOCAL_PREFIX = 'local:';
export const isLocalPlace = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(LOCAL_PREFIX);
/** folder: items shown per folder; names: names read from one folder before giving up on counting; results and
 *  visited: a search's matches and the items it looks through; depth: how deep a search goes. */
export const LIMITS = { folder: 2000, names: 20_000, results: 300, visited: 20_000, depth: 12 };
export type Limits = typeof LIMITS;
const SAVED = 'ni:studio:browser.local-folders.v1';

const KINDS: Record<string, BrowserKind> = Object.fromEntries([
  ...['mp4', 'mov', 'm4v', 'webm', 'mkv'].map(e => [e, 'video']),
  ...['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'tif', 'tiff', 'avif', 'bmp', 'svg'].map(e => [e, 'image']),
  ...['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aif', 'aiff'].map(e => [e, 'audio']),
  ...['otf', 'ttf', 'woff', 'woff2'].map(e => [e, 'font']),
  ...['pdf', 'md', 'txt', 'json', 'csv', 'html'].map(e => [e, 'document']),
]) as Record<string, BrowserKind>;
/** What the Studio's importer takes as it is (media-drop.ts holds the same list for dropped files). */
const IMPORTABLE = new Set(['mp4', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp']);
const extOf = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
export const kindOf = (name: string): BrowserKind => KINDS[extOf(name)] ?? 'other';
/** Whether a file can be added to a video: the importer's own types, an M4V (an MP4 by another name), or a still this
 *  page can draw (HEIC, TIFF, GIF, AVIF, BMP, SVG), which is turned into a PNG or JPEG first. */
export const addable = (name: string) => { const ext = extOf(name); return IMPORTABLE.has(ext) || ext === 'm4v' || kindOf(name) === 'image'; };
export const hidden = (name: string) => name.startsWith('.') || name === 'node_modules' || name === '__pycache__' || name.endsWith('.icloud') || name === 'Thumbs.db' || name === 'desktop.ini' || name === '$RECYCLE.BIN';
const byName = (a: { name: string; kind: BrowserKind }, b: { name: string; kind: BrowserKind }) =>
  Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const join = (path: string, name: string) => path ? `${path}/${name}` : name;
const fileEntry = (name: string, path: string, size?: number, modified?: number): LocalEntry => {
  const kind = kindOf(name);
  return { name, path, kind, ...(size != null ? { size } : {}), ...(modified != null ? { modified } : {}), ...(kind === 'video' || kind === 'image' || kind === 'audio' ? { addable: addable(name) } : {}) };
};

// ── How this page can read a folder ──────────────────────────────────────────────

type SupportEnv = { showDirectoryPicker?: unknown; isSecureContext?: boolean; indexedDB?: unknown; HTMLInputElement?: { prototype: object } };
/** kept when the page has folder handles and somewhere to keep them, session when its file input takes a folder,
 *  files otherwise. */
export function folderSupport(env: SupportEnv = globalThis as SupportEnv): FolderSupport {
  if (typeof env.showDirectoryPicker === 'function' && env.isSecureContext !== false && env.indexedDB) return 'kept';
  if (env.HTMLInputElement && 'webkitdirectory' in env.HTMLInputElement.prototype) return 'session';
  return 'files';
}

// ── The two kinds of folder ──────────────────────────────────────────────────────

export type FileHandleLike = { kind: 'file'; name: string; getFile(): Promise<File> };
export type DirHandleLike = {
  kind: 'directory'; name: string;
  entries(): AsyncIterable<[string, FileHandleLike | DirHandleLike]>;
  getDirectoryHandle(name: string): Promise<DirHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  queryPermission?(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'read' }): Promise<PermissionState>;
  isSameEntry?(other: DirHandleLike): Promise<boolean>;
};
/** A file from a folder input: its path inside the chosen folder, the folder's own name first. */
export type FileLike = File & { webkitRelativePath?: string };
export type FileIndex = { root: string | null; dirs: Map<string, LocalEntry[]>; files: Map<string, FileLike>; count: number };
/** A folder handle (with the handles met while listing it, so a file is reached without walking again), or the
 *  files a folder input handed over. */
export type LocalSource = { type: 'handle'; root: DirHandleLike; handles: Map<string, FileHandleLike | DirHandleLike> } | { type: 'files'; index: FileIndex };
export const handleSource = (root: DirHandleLike): LocalSource => ({ type: 'handle', root, handles: new Map() });

/** The files of a folder input, as folders and files by path. Reads names, sizes and dates only. */
export function indexFiles(list: ArrayLike<FileLike>): FileIndex {
  const dirs = new Map<string, LocalEntry[]>([['', []]]), files = new Map<string, FileLike>();
  let root: string | null = null, count = 0;
  const ensure = (path: string) => {
    if (dirs.has(path)) return;
    const cut = path.lastIndexOf('/'), parent = cut < 0 ? '' : path.slice(0, cut);
    ensure(parent); dirs.get(parent)!.push({ name: path.slice(cut + 1), path, kind: 'folder' }); dirs.set(path, []);
  };
  for (let i = 0; i < list.length; i++) {
    const file = list[i]!, parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);
    if (parts.length > 1) { root ??= parts[0]!; parts.shift(); }
    if (!parts.length || parts.some(hidden)) continue;
    const path = parts.join('/'); if (files.has(path)) continue;
    const parent = parts.slice(0, -1).join('/'); ensure(parent);
    dirs.get(parent)!.push(fileEntry(parts.at(-1)!, path, file.size, file.lastModified));
    files.set(path, file); count++;
  }
  for (const entries of dirs.values()) entries.sort(byName);
  return { root, dirs, files, count };
}

/** A folder the person linked is gone, or the page may no longer read it. */
export class LocalFolderError extends Error {
  constructor(message: string, readonly reason: 'missing' | 'permission') { super(message); }
}
const failure = (error: unknown, what: string): Error => {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotFoundError' || name === 'NotReadableError') return new LocalFolderError(`${what} can’t be found on this computer. It may have been moved, renamed or deleted.`, 'missing');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new LocalFolderError(`The browser no longer lets the Studio read ${what}.`, 'permission');
  return error instanceof Error ? error : new Error(String(error));
};

async function dirAt(source: Extract<LocalSource, { type: 'handle' }>, path: string): Promise<DirHandleLike> {
  if (!path) return source.root;
  const known = source.handles.get(path); if (known?.kind === 'directory') return known;
  const cut = path.lastIndexOf('/'), parent = await dirAt(source, cut < 0 ? '' : path.slice(0, cut));
  const dir = await parent.getDirectoryHandle(path.slice(cut + 1)); source.handles.set(path, dir); return dir;
}

/** Run `fn` over `items`, `width` at a time. */
async function inBatches<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}

/** One folder's items, folders first, at most `limits.folder` of them. A handle's files are looked at (size and date),
 *  never read. */
export async function listLocal(source: LocalSource, path: string, limits: Limits = LIMITS): Promise<LocalListing> {
  if (source.type === 'files') {
    const all = source.index.dirs.get(path);
    if (!all) throw new LocalFolderError('That folder is not in the files this page was given.', 'missing');
    return { entries: all.slice(0, limits.folder), truncated: all.length > limits.folder, total: all.length };
  }
  try {
    const dir = await dirAt(source, path), found: { name: string; handle: FileHandleLike | DirHandleLike; kind: BrowserKind }[] = [];
    let counted = true;
    for await (const [name, handle] of dir.entries()) {
      if (hidden(name)) continue;
      if (found.length >= limits.names) { counted = false; break; }
      found.push({ name, handle, kind: handle.kind === 'directory' ? 'folder' : kindOf(name) });
    }
    found.sort(byName);
    const kept = found.slice(0, limits.folder);
    const entries = await inBatches(kept, 32, async ({ name, handle }): Promise<LocalEntry> => {
      const child = join(path, name); source.handles.set(child, handle);
      if (handle.kind === 'directory') return { name, path: child, kind: 'folder' };
      try { const file = await handle.getFile(); return fileEntry(name, child, file.size, file.lastModified); } catch { return fileEntry(name, child); }
    });
    return { entries, truncated: !counted || found.length > kept.length, total: counted ? found.length : null };
  } catch (error) { throw failure(error, path ? `“${path.split('/').at(-1)}”` : 'This folder'); }
}

/** Files and folders whose path holds every word of `query` (and whose name holds one of them), like the Studio
 *  library's search. Stops at `limits.results` matches, after `limits.visited` items or `limits.depth` folders down. */
export async function searchLocal(source: LocalSource, query: string, options: { kind?: BrowserKind | null; signal?: AbortSignal; limits?: Limits } = {}): Promise<LocalSearch> {
  const limits = options.limits ?? LIMITS, words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], truncated: false };
  const matches = (path: string, name: string, kind: BrowserKind) => {
    const hay = path.toLowerCase(), low = name.toLowerCase();
    return words.every(w => hay.includes(w)) && words.some(w => low.includes(w)) && (!options.kind || options.kind === kind);
  };
  const results: LocalEntry[] = [];
  if (source.type === 'files') {
    for (const entries of source.index.dirs.values()) for (const e of entries) {
      if (results.length >= limits.results) return { results, truncated: true };
      if (matches(e.path, e.name, e.kind)) results.push(e);
    }
    return { results, truncated: false };
  }
  const queue: { dir: DirHandleLike; path: string; depth: number }[] = [{ dir: source.root, path: '', depth: 0 }];
  let visited = 0, cut = false;
  const files: { entry: LocalEntry; handle: FileHandleLike }[] = [];
  walk: while (queue.length) {
    const { dir, path, depth } = queue.shift()!;
    try {
      for await (const [name, handle] of dir.entries()) {
        if (options.signal?.aborted) return { results: [], truncated: false };
        if (hidden(name)) continue;
        if (++visited > limits.visited || results.length >= limits.results) { cut = true; break walk; }
        const child = join(path, name), kind: BrowserKind = handle.kind === 'directory' ? 'folder' : kindOf(name);
        source.handles.set(child, handle);
        if (matches(child, name, kind)) {
          const entry: LocalEntry = kind === 'folder' ? { name, path: child, kind } : fileEntry(name, child);
          results.push(entry); if (handle.kind === 'file') files.push({ entry, handle });
        }
        if (handle.kind === 'directory') { if (depth + 1 < limits.depth) queue.push({ dir: handle, path: child, depth: depth + 1 }); else cut = true; }
      }
    } catch (error) { if (!path) throw failure(error, 'This folder'); /* a subfolder that can't be read is skipped */ }
  }
  // Sizes for what was found (looked at, not read).
  await inBatches(files, 32, async ({ entry, handle }) => { try { const f = await handle.getFile(); entry.size = f.size; entry.modified = f.lastModified; } catch { /* listed without a size */ } });
  results.sort(byName);
  return { results, truncated: cut };
}

/** The file at `path`, to preview or add. A handle's file is the file on disk as it is now. */
export async function fileAt(source: LocalSource, path: string): Promise<File> {
  const name = path.split('/').at(-1) ?? path;
  if (source.type === 'files') {
    const file = source.index.files.get(path);
    if (!file) throw new LocalFolderError(`“${name}” is not in the files this page was given.`, 'missing');
    return file;
  }
  try {
    let handle = source.handles.get(path);
    if (handle?.kind !== 'file') {
      const cut = path.lastIndexOf('/');
      handle = await (await dirAt(source, cut < 0 ? '' : path.slice(0, cut))).getFileHandle(name);
      source.handles.set(path, handle);
    }
    return await handle.getFile();
  } catch (error) { throw failure(error, `“${name}”`); }
}

// ── Getting a file ready for the importer ────────────────────────────────────────

/** Draw a still the importer does not take (HEIC, TIFF, GIF, AVIF, BMP, SVG) as a PNG or JPEG. Browser only. */
export async function convertStill(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    await img.decode().catch(() => { throw new Error(`${file.name} can’t be read here. Save it as a JPEG or PNG first, then add it.`); });
    const w = img.naturalWidth || 1600, h = img.naturalHeight || 900;
    if (w * h > 50_000_000) throw new Error(`${file.name} is too large a picture to turn into a JPEG here. Save a smaller copy first.`);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    const alpha = /\.(svg|gif)$/i.test(file.name), type = alpha ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.92));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error(`${file.name} could not be turned into a ${alpha ? 'PNG' : 'JPEG'}.`);
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.${alpha ? 'png' : 'jpg'}`, { type, lastModified: file.lastModified });
  } finally { URL.revokeObjectURL(url); }
}

/** The file to upload for `file`: itself, an M4V under an MP4 name (the same bytes, nothing copied), or a converted
 *  still. Anything else can be previewed but not added. */
export async function importableFile(file: File, convert: (file: File) => Promise<File> = convertStill): Promise<File> {
  const ext = extOf(file.name);
  if (IMPORTABLE.has(ext)) return file;
  if (ext === 'm4v') return new File([file], `${file.name.slice(0, -4)}.mp4`, { type: 'video/mp4', lastModified: file.lastModified });
  if (kindOf(file.name) === 'image') return convert(file);
  throw new Error(kindOf(file.name) === 'audio' ? `${file.name} can’t be added. Save it as WAV, MP3 or M4A first.` : `${file.name} can be previewed but not added to a video.`);
}

// ── Keeping the list, and a kept folder's handle ─────────────────────────────────

export type HandleStore = { get(id: string): Promise<DirHandleLike | undefined>; put(id: string, handle: DirHandleLike): Promise<void>; delete(id: string): Promise<void> };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The linked folders this browser remembers: names and how each is linked, never a file. */
export function readSaved(storage: StorageLike | null): LocalPlace[] {
  try {
    const raw = storage?.getItem(SAVED), list = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is LocalPlace => !!p && typeof p.id === 'string' && isLocalPlace(p.id) && typeof p.name === 'string' && (p.mode === 'kept' || p.mode === 'session'))
      .map(p => ({ id: p.id, name: p.name.slice(0, 200), mode: p.mode, ...(p.flat ? { flat: true } : {}) }));
  } catch { return []; }
}
function writeSaved(storage: StorageLike | null, list: LocalPlace[]) {
  try { storage?.setItem(SAVED, JSON.stringify(list.map(({ id, name, mode, flat }) => ({ id, name, mode, ...(flat ? { flat } : {}) })))); } catch { /* private mode: linked for this visit */ }
}

/** Folder handles in IndexedDB (a handle can be stored there and nowhere else). */
export function indexedDbHandles(idb: IDBFactory = indexedDB): HandleStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open('ni-studio-local-folders', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('handles'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const run = async <T,>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('handles', mode), request = fn(tx.objectStore('handles'));
        tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  };
  return {
    get: id => run('readonly', s => s.get(id) as IDBRequest<DirHandleLike | undefined>),
    put: async (id, handle) => { await run('readwrite', s => s.put(handle, id)); },
    delete: async id => { await run('readwrite', s => s.delete(id)); },
  };
}

// ── The linked folders ───────────────────────────────────────────────────────────

export type LocalDeps = {
  storage: StorageLike | null;
  handles: HandleStore;
  support: () => FolderSupport;
  /** The browser's folder picker; null when the person cancels. */
  pickDirectory: () => Promise<DirHandleLike | null>;
  /** A file input (a folder input when `folders`); null when the person cancels. */
  pickFiles: (folders: boolean) => Promise<FileLike[] | null>;
  newId: () => string;
};
export type AddResult = { id: string; existing: boolean } | null;

/** The folders linked on this computer, their state, and what each one holds while the page is open. */
export class LocalFolders {
  private list: LocalPlaceView[] = [];
  private readonly sources = new Map<string, LocalSource>();
  /** A kept folder's handle while the browser waits for the person's OK. */
  private readonly waiting = new Map<string, DirHandleLike>();
  private readonly listeners = new Set<() => void>();
  private started: Promise<void> | null = null;
  constructor(private readonly deps: LocalDeps) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  places = () => this.list;
  support = () => this.deps.support();
  private set(list: LocalPlaceView[]) { this.list = list; writeSaved(this.deps.storage, list); for (const l of this.listeners) l(); }
  private patch(id: string, change: Partial<LocalPlaceView>) { this.set(this.list.map(p => p.id === id ? { ...p, ...change } : p)); }
  place(id: string) { return this.list.find(p => p.id === id) ?? null; }

  /** Read the remembered folders: a kept one is ready when the browser still lets the page read it, waits for the
   *  person's OK when it asks again, and is missing when its handle is gone; a session one is ready only if it was
   *  chosen since this page opened. */
  start(): Promise<void> {
    this.started ??= (async () => {
      const saved = readSaved(this.deps.storage);
      this.set(saved.map(p => ({ ...p, status: p.mode === 'kept' ? 'checking' : this.sources.has(p.id) ? 'ready' : 'choose-again' })));
      await Promise.all(saved.filter(p => p.mode === 'kept').map(async p => {
        let handle: DirHandleLike | undefined;
        try { handle = await this.deps.handles.get(p.id); } catch { handle = undefined; }
        if (!handle) { this.patch(p.id, { status: 'missing' }); return; }
        let state: PermissionState = 'prompt';
        try { state = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted'; } catch { state = 'prompt'; }
        if (state === 'granted') { this.sources.set(p.id, handleSource(handle)); this.patch(p.id, { status: 'ready' }); }
        else { this.waiting.set(p.id, handle); this.patch(p.id, { status: 'ask' }); }
      }));
    })();
    return this.started;
  }

  /** Link a folder: kept where the browser hands a folder handle, for this visit otherwise. The same folder twice
   *  opens the one already linked. Null when the person cancels. */
  async add(): Promise<AddResult> {
    const support = this.deps.support();
    if (support === 'kept') {
      let handle: DirHandleLike | null = null, fallback = false;
      try { handle = await this.deps.pickDirectory(); } catch (error) {
        // A page that may not use the picker (inside a frame, a policy) still has the folder input.
        if ((error as { name?: string })?.name === 'SecurityError' || error instanceof TypeError) fallback = true; else throw error;
      }
      if (!fallback) return handle ? this.keep(handle) : null;
    }
    const files = await this.deps.pickFiles(support !== 'files');
    return files ? this.adopt(files) : null;
  }

  private async keep(handle: DirHandleLike): Promise<AddResult> {
    for (const p of this.list.filter(p => p.mode === 'kept')) {
      const known = this.sources.get(p.id), other = known?.type === 'handle' ? known.root : this.waiting.get(p.id);
      if (other && await other.isSameEntry?.(handle).catch(() => false)) {
        // Picking the folder again is the person's OK.
        this.waiting.delete(p.id); this.sources.set(p.id, handleSource(handle)); this.patch(p.id, { status: 'ready' });
        return { id: p.id, existing: true };
      }
    }
    const id = `${LOCAL_PREFIX}${this.deps.newId()}`;
    // A browser that can't keep the handle (storage full or blocked) still has the folder until the page reloads.
    let kept = true;
    try { await this.deps.handles.put(id, handle); } catch { kept = false; }
    this.sources.set(id, handleSource(handle));
    this.set([...this.list, { id, name: handle.name || 'Folder', mode: kept ? 'kept' : 'session', status: 'ready' }]);
    return { id, existing: false };
  }

  /** Files from a folder input. A folder with the same name waiting to be chosen again takes them. */
  private adopt(files: FileLike[], into?: string): AddResult {
    const index = indexFiles(files);
    if (!index.count) throw new Error(index.root ? `“${index.root}” has nothing in it the Studio can list.` : 'That folder has no files in it, so there is nothing to link.');
    const name = index.root ?? 'Chosen files', flat = !index.root;
    const target = into ? this.place(into) : this.list.find(p => p.mode === 'session' && p.name === name && p.status !== 'ready') ?? null;
    if (target) {
      this.sources.set(target.id, { type: 'files', index });
      this.patch(target.id, { name, status: 'ready', mode: 'session', ...(flat ? { flat } : { flat: undefined }) });
      return { id: target.id, existing: true };
    }
    const id = `${LOCAL_PREFIX}${this.deps.newId()}`;
    this.sources.set(id, { type: 'files', index });
    this.set([...this.list, { id, name, mode: 'session', status: 'ready', ...(flat ? { flat } : {}) }]);
    return { id, existing: false };
  }

  /** Ask the browser to let the page read a kept folder again (from the person's click). */
  async allow(id: string): Promise<boolean> {
    const handle = this.waiting.get(id); if (!handle) return this.place(id)?.status === 'ready';
    let state: PermissionState = 'denied';
    try { state = (await handle.requestPermission?.({ mode: 'read' })) ?? 'granted'; } catch { state = 'denied'; }
    if (state !== 'granted') return false;
    this.waiting.delete(id); this.sources.set(id, handleSource(handle)); this.patch(id, { status: 'ready' });
    return true;
  }

  /** Choose a folder again: a session folder after a reload, a kept folder that went missing, or to take in changes. */
  async chooseAgain(id: string): Promise<AddResult> {
    const place = this.place(id); if (!place) return null;
    const support = this.deps.support();
    if (place.mode === 'kept' && support === 'kept') {
      const handle = await this.deps.pickDirectory(); if (!handle) return null;
      await this.deps.handles.put(id, handle);
      this.waiting.delete(id); this.sources.set(id, handleSource(handle));
      this.patch(id, { name: handle.name || place.name, status: 'ready' });
      return { id, existing: true };
    }
    const files = await this.deps.pickFiles(support !== 'files');
    return files ? this.adopt(files, id) : null;
  }

  /** Forget a folder (its files stay where they are). */
  async remove(id: string) {
    this.sources.delete(id); this.waiting.delete(id);
    this.set(this.list.filter(p => p.id !== id));
    await this.deps.handles.delete(id).catch(() => {});
  }

  /** A folder that could not be read: gone, or no longer allowed. */
  lost(id: string, error: unknown) {
    const place = this.place(id); if (!place) return;
    if (error instanceof LocalFolderError && error.reason === 'permission' && place.mode === 'kept') {
      const source = this.sources.get(id); if (source?.type === 'handle') this.waiting.set(id, source.root);
      this.sources.delete(id); this.patch(id, { status: 'ask' }); return;
    }
    this.sources.delete(id); this.patch(id, { status: place.mode === 'kept' ? 'missing' : 'choose-again' });
  }

  private source(id: string): LocalSource {
    const source = this.sources.get(id), place = this.place(id);
    if (!source) throw new LocalFolderError(place ? `“${place.name}” is not linked just now. Choose it again to use it.` : 'That folder is no longer linked.', 'missing');
    return source;
  }
  listFolder = async (id: string, path: string, limits?: Limits) => listLocal(this.source(id), path, limits);
  search = async (id: string, query: string, options?: Parameters<typeof searchLocal>[2]) => searchLocal(this.source(id), query, options);
  file = async (id: string, path: string) => fileAt(this.source(id), path);
}

// ── The page's own ───────────────────────────────────────────────────────────────

/** The browser's folder input, hidden; it is put in the page while it opens (Safari wants it there). */
export function pickWithInput(folders: boolean, doc: Document = document): Promise<FileLike[] | null> {
  return new Promise(resolve => {
    const input = doc.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true;
    if (folders) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    let done = false;
    const finish = (files: FileLike[] | null) => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish(Array.from(input.files ?? []) as FileLike[]));
    input.addEventListener('cancel', () => finish(null));
    doc.body.appendChild(input); input.click();
  });
}

async function pickDirectory(): Promise<DirHandleLike | null> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandleLike> }).showDirectoryPicker;
  try { return await picker.call(window, { id: 'ni-studio-library', mode: 'read' }); }
  catch (error) { if ((error as { name?: string })?.name === 'AbortError') return null; throw error; }
}

let shared: LocalFolders | null = null;
/** This page's linked folders (one list for every Browser panel the page opens). */
export function localFolders(): LocalFolders {
  shared ??= new LocalFolders({
    storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    handles: typeof indexedDB === 'undefined' ? { get: async () => undefined, put: async () => {}, delete: async () => {} } : indexedDbHandles(),
    support: () => folderSupport(window as unknown as SupportEnv),
    pickDirectory,
    pickFiles: folders => pickWithInput(folders),
    newId: () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  });
  return shared;
}
