// The Browser (as in Ableton Live): places on the left, their contents on the right, a preview of the selected file
// underneath. In a workspace there are two fixed places: the Studio library (every video, image and sound already
// imported) and the workspace's own Files (images, video and sound attached to captures, actions and projects).
// Under them, "This computer": folders the person links from their own computer (local-folders.ts). The server can't
// read this computer, so a linked folder is listed, searched and previewed in this page, and a file from it is
// uploaded into the Studio library only when the person adds it (the same upload and import as a dropped file).
// Footage, stills and sound can be added to the video with Enter, a double-click, the button, or by dragging them
// out of the Browser onto the editor; a workspace file is imported into the Studio library on the way.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { EditorAsset } from '@/lib/studio/engine/contracts';
import type { EditorJob } from '@/lib/studio/engine/api';
import { isDesktopApp } from '@/lib/platform';
import { finishedJob, importFile, request } from './client';
import { Icon, type IconName } from './icons';
import { isMenuKey, useContextMenu, type MenuItem } from './ContextMenu';
import { importableFile, isLocalPlace, LocalFolderError, localFolders, type LocalPlaceView } from './local-folders';
import { forgetThumbs, localThumb } from './local-thumbs';

export type BrowserKind = 'folder' | 'video' | 'image' | 'audio' | 'font' | 'document' | 'other';
type Place = { id: string; name: string; path: string; available: boolean; local?: LocalPlaceView };
type Entry = { name: string; path: string; kind: BrowserKind; size?: number; modified?: number; thumbnail?: boolean; addable?: boolean; placeId?: string; placeName?: string };
type Info = { kind: BrowserKind; size: number; width?: number; height?: number; durationSeconds?: number; hasAudio?: boolean; codec?: string };
type Cut = { shown: number; total: number | null };
type Row = { entry: Entry; depth: number } | { note: string; depth: number; key: string };
export type BrowserItem = { place: string; path: string; name: string; kind: BrowserKind };
export const BROWSER_DRAG = 'application/x-ni-studio-browser';
const ADDABLE: BrowserKind[] = ['video', 'image', 'audio'];
const FILTERS: { kind: BrowserKind | null; label: string }[] = [{ kind: null, label: 'All' }, { kind: 'video', label: 'Video' }, { kind: 'image', label: 'Images' }, { kind: 'audio', label: 'Sound' }];
const ICONS: Record<BrowserKind, IconName> = { folder: 'folder', video: 'clip', image: 'image', audio: 'audio', font: 'type', document: 'transcript', other: 'file' };
const NO_LOCALS: LocalPlaceView[] = [];
const q = (place: string, path: string) => `place=${encodeURIComponent(place)}&path=${encodeURIComponent(path)}`;
const thumbUrl = (place: string, path: string) => `/api/account/studio/browser/thumb?${q(place, path)}`;
const fileUrl = (place: string, path: string) => `/api/account/studio/browser/file?${q(place, path)}`;
const addLabel = (kind: BrowserKind) => kind === 'video' ? 'Add clip' : kind === 'image' ? 'Use as background' : 'Add sound';
const canAdd = (e: Entry) => ADDABLE.includes(e.kind) && e.addable !== false;
const bytes = (n?: number) => n == null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
const clock = (s?: number) => s == null || !Number.isFinite(s) ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s < 60 ? `.${Math.floor((s % 1) * 10)}` : ''}`;
const count = (n: number) => n.toLocaleString('en-US');
const stored = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
/** What a cut folder listing says under its last row. */
export const cutNote = (cut: Cut) => cut.total != null ? `Showing ${count(cut.shown)} of ${count(cut.total)} items. Search to find the rest.` : `Showing the first ${count(cut.shown)} items. Search to find the rest.`;

/** Add a Browser item to the Studio library (a library item is answered at once; a workspace file is imported, which
 *  may take a while; a file from a folder on this computer is uploaded and imported like a file dropped on the
 *  editor, with the same checks on the server). */
export async function browserImport(item: BrowserItem): Promise<{ asset: EditorAsset }> {
  if (isLocalPlace(item.place)) {
    const file = await importableFile(await localFolders().file(item.place, item.path));
    const { asset } = await importFile<{ asset?: EditorAsset }>(file);
    if (!asset) throw new Error(`${item.name} could not be added.`);
    return { asset };
  }
  const answer = await request<{ asset?: EditorAsset; job?: EditorJob }>('/api/account/studio/browser/import', { place: item.place, path: item.path });
  if (answer.asset) return { asset: answer.asset };
  const job = answer.job ? await finishedJob(answer.job.id) : null;
  if (!job?.asset) throw new Error(`${item.name} could not be added.`);
  return { asset: job.asset };
}

export function BrowserPanel({ add, disabled, notify }: { add: (item: BrowserItem) => void; disabled: boolean; notify: (text: string, error?: boolean) => void }) {
  const [folders] = useState(localFolders);
  const locals = useSyncExternalStore(folders.subscribe, folders.places, () => NO_LOCALS);
  const [serverPlaces, setServerPlaces] = useState<Place[] | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(() => stored('ni:studio:browser.place', null));
  const [tree, setTree] = useState<Record<string, Entry[]>>({});
  const [cuts, setCuts] = useState<Record<string, Cut>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Entry | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [filter, setFilter] = useState<BrowserKind | null>(() => stored('ni:studio:browser.filter', null));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [searchCut, setSearchCut] = useState(false);
  const [reload, setReload] = useState(0);
  const [autoPlay, setAutoPlay] = useState<boolean>(() => stored('ni:studio:browser.autoplay', true));
  const [width, setWidth] = useState<number>(() => stored('ni:studio:browser.w2', 340));
  const openMenu = useContextMenu();
  const listRef = useRef<HTMLDivElement>(null);
  // The editor passes a new notify on every render; read it through a ref so effects don't refetch each time.
  const say = useRef(notify); say.current = notify;
  const fail = useCallback((e: unknown) => say.current((e as Error).message, true), []);
  const localPlaces = useMemo<Place[]>(() => locals.map(l => ({ id: l.id, name: l.name, path: '', available: l.status === 'ready', local: l })), [locals]);
  const places = useMemo(() => [...(serverPlaces ?? []), ...localPlaces], [serverPlaces, localPlaces]);
  const place = places.find(p => p.id === placeId) ?? null;
  const support = folders.support();

  useEffect(() => { void folders.start(); }, [folders]);
  const loadPlaces = useCallback(async () => { const { places } = await request<{ places: Place[] }>('/api/account/studio/browser/places'); setServerPlaces(places); }, []);
  useEffect(() => { void loadPlaces().catch(e => { setServerPlaces([]); fail(e); }); }, [loadPlaces, fail]);
  // Once the places are known, a remembered place that is gone gives way to the first one.
  useEffect(() => { if (serverPlaces && (!placeId || !places.some(p => p.id === placeId))) setPlaceId(places[0]?.id ?? null); }, [serverPlaces, places, placeId]);
  useEffect(() => keep('ni:studio:browser.place', placeId), [placeId]);
  useEffect(() => keep('ni:studio:browser.filter', filter), [filter]);
  useEffect(() => keep('ni:studio:browser.autoplay', autoPlay), [autoPlay]);
  useEffect(() => keep('ni:studio:browser.w2', width), [width]);

  const loadFolder = useCallback(async (path: string) => {
    if (!placeId) return;
    const key = `${placeId}:${path}`;
    if (isLocalPlace(placeId)) {
      try {
        const listing = await folders.listFolder(placeId, path);
        setTree(t => ({ ...t, [key]: listing.entries.map(e => ({ ...e, placeId })) }));
        setCuts(c => { const next = { ...c }; if (listing.truncated) next[key] = { shown: listing.entries.length, total: listing.total }; else delete next[key]; return next; });
      } catch (error) {
        // The folder itself is gone or no longer allowed: its place says so. A subfolder's trouble is told.
        if (error instanceof LocalFolderError && !path) { folders.lost(placeId, error); return; }
        throw error;
      }
      return;
    }
    const listing = await request<{ entries: Entry[] }>(`/api/account/studio/browser/list?${q(placeId, path)}`);
    setTree(t => ({ ...t, [key]: listing.entries.map(e => ({ ...e, placeId })) }));
  }, [placeId, folders]);
  // A new place (or one chosen again): start at its top level, closed.
  useEffect(() => { setTree({}); setCuts({}); setExpanded(new Set()); setSelected(null); setResults(null); if (placeId && place?.available) void loadFolder('').catch(fail); }, [placeId, place?.available, loadFolder, fail, reload]);

  // Search the selected place as you type: the server's places on the server, a linked folder here.
  useEffect(() => {
    if (!query.trim()) { setResults(null); setSearchCut(false); return; }
    if (placeId && isLocalPlace(placeId)) {
      if (!place?.available) { setResults(null); return; }
      const stop = new AbortController(), name = place.name, id = placeId;
      const timer = setTimeout(() => {
        void folders.search(id, query, { kind: filter, signal: stop.signal })
          .then(r => { if (!stop.signal.aborted) { setResults(r.results.map(e => ({ ...e, placeId: id, placeName: name }))); setSearchCut(r.truncated); } })
          .catch(e => { if (!stop.signal.aborted) fail(e); });
      }, 180);
      return () => { clearTimeout(timer); stop.abort(); };
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, ...(placeId ? { place: placeId } : {}), ...(filter ? { kind: filter } : {}) });
      void request<{ results: Entry[]; truncated?: boolean }>(`/api/account/studio/browser/search?${params}`).then(r => { setResults(r.results); setSearchCut(!!r.truncated); }).catch(fail);
    }, 180);
    return () => clearTimeout(timer);
  }, [query, placeId, filter, fail, folders, place?.available, place?.name]);

  useEffect(() => {
    setInfo(null); const owner = selected?.placeId ?? placeId;
    if (!selected || !owner || selected.kind === 'folder') return;
    // A file on this computer: what the listing knows; the preview adds its picture size and length.
    if (isLocalPlace(owner)) { setInfo({ kind: selected.kind, size: selected.size ?? 0 }); return; }
    let live = true; void request<Info>(`/api/account/studio/browser/info?${q(owner, selected.path)}`).then(i => { if (live) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, [selected, placeId]);

  const rows = useMemo(() => {
    if (results) return results.map((e): Row => ({ entry: e, depth: 0 }));
    const out: Row[] = [];
    const walk = (path: string, depth: number) => {
      for (const e of tree[`${placeId}:${path}`] ?? []) {
        if (filter && e.kind !== 'folder' && e.kind !== filter) continue;
        out.push({ entry: e, depth }); if (e.kind === 'folder' && expanded.has(e.path)) walk(e.path, depth + 1);
      }
      const cut = cuts[`${placeId}:${path}`]; if (cut) out.push({ note: cutNote(cut), depth, key: `cut:${path}` });
    };
    walk('', 0); return out;
  }, [tree, cuts, expanded, filter, results, placeId]);
  const entryRows = useMemo(() => rows.filter((r): r is { entry: Entry; depth: number } => 'entry' in r), [rows]);

  const toggle = (e: Entry, open?: boolean) => {
    const next = new Set(expanded), isOpen = expanded.has(e.path), want = open ?? !isOpen;
    if (want) { next.add(e.path); if (!tree[`${placeId}:${e.path}`]) void loadFolder(e.path).catch(err => notify((err as Error).message, true)); } else next.delete(e.path);
    setExpanded(next);
  };
  const itemFor = (e: Entry): BrowserItem | null => { const owner = e.placeId ?? placeId; return owner ? { place: owner, path: e.path, name: e.name, kind: e.kind } : null; };
  const addEntry = (e: Entry) => { const item = itemFor(e); if (!item || !canAdd(e) || disabled) return; add(item); };
  const open = (id: string) => { setPlaceId(id); setQuery(''); };

  // Folders on this computer.
  const addFolder = async () => { try { const linked = await folders.add(); if (linked) { open(linked.id); setReload(n => n + 1); } } catch (e) { fail(e); } };
  const chooseAgain = async (p: Place) => { try { const linked = await folders.chooseAgain(p.id); if (linked) { forgetThumbs(`${p.id}:`); open(p.id); setReload(n => n + 1); } } catch (e) { fail(e); } };
  const allow = async (p: Place) => { if (await folders.allow(p.id)) open(p.id); else say.current(`The browser did not allow reading “${p.name}”.`, true); };
  const removeLocal = async (p: Place) => { forgetThumbs(`${p.id}:`); await folders.remove(p.id); say.current(`“${p.name}” is no longer in the Browser. The folder and its files stay where they are.`); };

  // Right-click menus: a place, and a file in the list.
  const placeMenu = (event: React.MouseEvent | React.KeyboardEvent, p: Place) => {
    const items: MenuItem[] = [{ label: 'Open', run: () => open(p.id), disabled: p.id === placeId }];
    const l = p.local;
    if (l) {
      if (l.status === 'ask') items.push({ label: 'Allow access', run: () => void allow(p) });
      if (l.mode === 'kept' && l.status === 'ready') items.push({ label: 'Refresh', run: () => { open(p.id); setReload(n => n + 1); } });
      if (l.mode === 'session' || l.status === 'missing') items.push({ label: 'Choose it again…', run: () => void chooseAgain(p) });
      items.push({ separator: true }, { label: 'Remove from the Browser', danger: true, run: () => void removeLocal(p), confirm: { text: `Remove “${p.name}” from the Browser? The folder and its files stay where they are.`, action: 'Remove' } });
    }
    openMenu(event as unknown as React.MouseEvent, items);
  };
  const entryMenu = (event: React.MouseEvent | React.KeyboardEvent, e: Entry) => {
    setSelected(e);
    const items: MenuItem[] = [];
    if (canAdd(e)) items.push({ label: addLabel(e.kind), run: () => addEntry(e), disabled, hint: '↵' });
    if (e.kind === 'folder' && !results) items.push({ label: expanded.has(e.path) ? 'Close' : 'Open', run: () => toggle(e) });
    if (items.length) openMenu(event as unknown as React.MouseEvent, items);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest('input')) return;
    const at = entryRows.findIndex(r => r.entry === selected || (selected && r.entry.path === selected.path && r.entry.placeId === selected.placeId));
    const go = (i: number) => { const r = entryRows[Math.max(0, Math.min(entryRows.length - 1, i))]; if (r) { setSelected(r.entry); listRef.current?.querySelector(`[data-row="${CSS.escape(r.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' }); } };
    if (ev.key === 'ArrowDown') { ev.preventDefault(); go(at + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(at < 0 ? 0 : at - 1); }
    else if (ev.key === 'ArrowRight' && selected?.kind === 'folder' && !results) { ev.preventDefault(); if (!expanded.has(selected.path)) toggle(selected, true); else go(at + 1); }
    else if (ev.key === 'ArrowLeft' && selected && !results) {
      ev.preventDefault();
      if (selected.kind === 'folder' && expanded.has(selected.path)) toggle(selected, false);
      else { const parent = selected.path.split('/').slice(0, -1).join('/'); const r = entryRows.find(r => r.entry.path === parent); if (r) setSelected(r.entry); }
    }
    else if (ev.key === 'Enter' && selected) { ev.preventDefault(); if (selected.kind === 'folder' && !results) toggle(selected); else addEntry(selected); }
    else if (ev.key === ' ') { ev.preventDefault(); window.dispatchEvent(new CustomEvent('ni-studio-browser-preview-toggle')); }
    else if (isMenuKey(ev) && selected) { ev.preventDefault(); const row = listRef.current?.querySelector(`[data-row="${CSS.escape(selected.path)}"]`); if (row) entryMenu({ ...ev, currentTarget: row, clientX: 0, clientY: 0 } as unknown as React.KeyboardEvent, selected); }
  };

  const placeRow = (p: Place) => {
    const l = p.local, state = l && l.status !== 'ready' ? ` s-${l.status}` : '';
    const title = !l ? p.name : l.status === 'ask' ? `${p.name}: allow access to open it` : l.status === 'choose-again' ? `${p.name}: choose it again to open it` : l.status === 'missing' ? `${p.name}: can’t be found` : l.mode === 'session' ? `${p.name}: linked until the page reloads` : p.name;
    return <div key={p.id} className={`ab-place${p.id === placeId ? ' on' : ''}${p.available || l ? '' : ' missing'}${l ? ' local' : ''}${state}`} title={title} onContextMenu={event => placeMenu(event, p)}>
      <button onClick={() => open(p.id)} onKeyDown={e => { if (isMenuKey(e)) { e.preventDefault(); placeMenu({ ...e, currentTarget: e.currentTarget, clientX: 0, clientY: 0 } as unknown as React.KeyboardEvent, p); } }}>
        <Icon name={l ? (l.status === 'missing' ? 'warning' : 'folder') : p.id === 'files' ? 'folder' : 'clip'} size={14} /><span>{p.name}</span></button>
      {l ? <button className="ab-place-x" aria-label={`Remove ${p.name} from the Browser`} title="Remove from the Browser" onClick={() => void removeLocal(p)}><Icon name="close" size={12} /></button> : null}
    </div>;
  };

  /** What the list shows for a linked folder that can't be opened just now. */
  const localCard = (p: Place, l: LocalPlaceView) => <div className="ab-empty ab-local-state">
    <Icon name={l.status === 'missing' ? 'warning' : 'folder'} size={22} />
    {l.status === 'checking' ? <p>Opening “{p.name}”…</p>
      : l.status === 'ask' ? <><p>The browser needs your OK to read “{p.name}” again.</p><div className="ab-local-actions"><button className="subtle-button" onClick={() => void allow(p)}>Allow access</button></div></>
      : l.status === 'choose-again' ? <><p>“{p.name}” was linked until the page reloaded. {isDesktopApp() ? 'The app' : 'This browser'} can’t keep a folder linked after that, only its name.</p><div className="ab-local-actions"><button className="subtle-button" onClick={() => void chooseAgain(p)}>Choose it again</button><button onClick={() => void removeLocal(p)}>Remove</button></div></>
      : <><p>“{p.name}” can’t be found on this computer. It may have been moved, renamed or deleted.</p><div className="ab-local-actions"><button className="subtle-button" onClick={() => void chooseAgain(p)}>Choose it again</button><button onClick={() => void removeLocal(p)}>Remove</button></div></>}
    <small>Files stay on this computer until you add one to the video.</small>
  </div>;

  const local = place?.local ?? null;
  return <aside className="asset-browser" style={{ width }} aria-label="Browser" onKeyDown={ev => { if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }}>
    <div className="ab-search"><Icon name="search" size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={place ? `Search ${place.name}` : 'Search everything'} aria-label="Search the Browser" onKeyDown={e => { if (e.key === 'Escape') setQuery(''); if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.focus(); if (entryRows[0]) setSelected(entryRows[0].entry); } }} />{query ? <button className="ab-clear" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><Icon name="close" size={14} /></button> : null}</div>
    <div className="ab-filters" role="tablist" aria-label="File types">{FILTERS.map(f => <button key={f.label} role="tab" aria-selected={filter === f.kind} className={filter === f.kind ? 'on' : ''} onClick={() => setFilter(f.kind)}>{f.label}</button>)}</div>
    <div className="ab-body">
      <nav className="ab-places" aria-label="Places">
        <div className="ab-head">Places</div>
        {(serverPlaces ?? []).map(placeRow)}
        <div className="ab-head ab-head-local">This computer</div>
        {localPlaces.map(placeRow)}
        <button className="ab-add" onClick={() => void addFolder()} title={support === 'kept' ? 'Link a folder. This browser keeps the link.' : 'Link a folder until the page reloads.'}>
          <Icon name="plus" size={12} /><span>{support === 'files' ? 'Add files from this computer' : 'Add a folder from this computer'}</span></button>
        <p className="ab-local-note">Nothing leaves this computer until you add a file.</p>
      </nav>
      <div className="ab-list" ref={listRef} tabIndex={0} onKeyDown={onKey} role="tree" aria-label={place ? place.name : 'Files'}>
        {!serverPlaces ? <div className="ab-empty"><Icon name="folder" size={22} /><p>Loading…</p></div>
          : local && !place!.available && !results ? localCard(place!, local)
          : place && !place.available && !results ? <div className="ab-empty"><p>“{place.name}” can’t be read just now.</p></div>
          : results && !results.length ? <div className="ab-empty"><p>Nothing matches “{query}”.</p></div>
          : !results && placeId && tree[`${placeId}:`]?.length === 0 ? <div className="ab-empty"><Icon name={local || placeId === 'files' ? 'folder' : 'clip'} size={22} /><p>{local ? `“${place!.name}” is empty.` : placeId === 'files' ? 'No images, video or sound in the workspace’s files yet.' : 'Nothing in the Studio library yet. Drop footage, stills or sound onto the editor to add them.'}</p></div>
          : <>{rows.map(row => {
            if ('note' in row) return <div key={row.key} className="ab-cut" style={{ paddingLeft: 22 + row.depth * 14 }}>{row.note}</div>;
            const { entry: e, depth } = row, owner = e.placeId ?? placeId!, isSel = !!selected && selected.path === e.path && selected.placeId === e.placeId;
            return <div key={`${owner}:${e.path}`} data-row={e.path} role="treeitem" aria-selected={isSel} aria-expanded={e.kind === 'folder' && !results ? expanded.has(e.path) : undefined}
              className={`ab-row k-${e.kind}${isSel ? ' sel' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}
              draggable={canAdd(e)} onDragStart={ev => { const item = itemFor(e); if (!item) return; ev.dataTransfer.setData(BROWSER_DRAG, JSON.stringify(item)); ev.dataTransfer.effectAllowed = 'copy'; }}
              onClick={() => { setSelected(e); if (e.kind === 'folder' && !results) toggle(e); listRef.current?.focus(); }} onDoubleClick={() => addEntry(e)}
              onContextMenu={event => { listRef.current?.focus(); entryMenu(event, e); }}>
              {e.kind === 'folder' && !results ? <span className={`ab-tri${expanded.has(e.path) ? ' open' : ''}`} aria-hidden="true"><Icon name="chevronRight" size={12}/></span> : <span className="ab-tri" aria-hidden="true" />}
              {isLocalPlace(owner) && (e.kind === 'image' || e.kind === 'video') ? <LocalThumb place={owner} entry={e} root={listRef} />
                : e.thumbnail && e.kind !== 'audio' ? <img className="ab-thumb" loading="lazy" src={thumbUrl(owner, e.path)} alt="" onError={ev => { (ev.target as HTMLImageElement).style.visibility = 'hidden'; }} /> : <span className="ab-icon"><Icon name={ICONS[e.kind]} size={14} /></span>}
              <span className="ab-name">{e.name}{results ? <small>{[e.placeName, ...e.path.split('/').slice(0, -1)].filter(Boolean).join(' / ')}</small> : null}</span>
              {e.size != null && e.kind !== 'folder' ? <span className="ab-size">{bytes(e.size)}</span> : null}
            </div>;
          })}
          {results && searchCut ? <div className="ab-cut">Showing the first {count(results.length)} matches. Type more to narrow it down.</div> : null}
          {local?.mode === 'session' && !results ? <div className="ab-cut ab-session-note">Linked until the page reloads. After that, choose the folder again.</div> : null}</>}
      </div>
    </div>
    <Preview entry={selected} owner={selected?.placeId ?? placeId} info={info} autoPlay={autoPlay} setAutoPlay={setAutoPlay} add={addEntry} disabled={disabled}
      onMeta={meta => setInfo(i => i ? { ...i, ...meta } : i)} />
    <div className="ab-resize" role="separator" aria-orientation="vertical" aria-label="Resize the Browser" onPointerDown={ev => {
      const start = ev.clientX, w = width; (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
      const move = (m: PointerEvent) => setWidth(Math.max(280, Math.min(560, w + m.clientX - start)));
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }} />
  </aside>;
}

/** A row's small picture for a file on this computer, made once the row scrolls into view (local-thumbs.ts). */
function LocalThumb({ place, entry, root }: { place: string; entry: Entry; root: React.RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const { path, kind, size, modified } = entry;
  useEffect(() => {
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined' || (kind !== 'image' && kind !== 'video')) return;
    let live = true, visible = false, asked = false;
    const observer = new IntersectionObserver(([seen]) => {
      visible = !!seen?.isIntersecting;
      if (!visible || asked) return;
      asked = true;
      void localThumb(`${place}:${path}:${size ?? ''}:${modified ?? ''}`, kind, () => localFolders().file(place, path), () => live && visible)
        .then(made => { if (!live) return; if (made) setUrl(made); else asked = false; });
    }, { root: root.current, rootMargin: '160px 0px' });
    observer.observe(el);
    return () => { live = false; observer.disconnect(); };
  }, [place, path, kind, size, modified, root]);
  return url ? <img className="ab-thumb" src={url} alt="" /> : <span ref={holder} className="ab-icon"><Icon name={ICONS[kind]} size={14} /></span>;
}

/** What the selected file looks or sounds like, plus what can be done with it. A file on this computer plays from an
 *  object URL (the browser reads it as it plays; nothing is loaded whole), and its text or font is read in part. */
function Preview({ entry, owner, info, autoPlay, setAutoPlay, add, disabled, onMeta }: { entry: Entry | null; owner: string | null; info: Info | null; autoPlay: boolean; setAutoPlay: (v: boolean) => void; add: (e: Entry) => void; disabled: boolean; onMeta: (meta: Partial<Info>) => void }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [text, setText] = useState<string | null>(null), [font, setFont] = useState<string | null>(null);
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const local = isLocalPlace(owner);
  useEffect(() => { const t = () => { const m = media.current; if (m) { if (m.paused) void m.play().catch(() => {}); else m.pause(); } }; window.addEventListener('ni-studio-browser-preview-toggle', t); return () => window.removeEventListener('ni-studio-browser-preview-toggle', t); }, []);
  useEffect(() => {
    setText(null); setFont(null); setTime(0); setLocalSrc(null);
    if (!entry || !owner || entry.kind === 'folder') return;
    const family = `ni-studio-browser-${Math.abs([...`${owner}:${entry.path}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
    const loadFont = (face: FontFace) => void face.load().then(f => { (document.fonts as unknown as { add(face: FontFace): void }).add(f); setFont(family); }).catch(() => setFont(null));
    if (!local) {
      if (entry.kind === 'document' && /\.(md|txt|json|csv)$/i.test(entry.name)) void fetch(fileUrl(owner, entry.path)).then(r => r.text()).then(t => setText(t.slice(0, 4000))).catch(() => {});
      if (entry.kind === 'font') loadFont(new FontFace(family, `url(${fileUrl(owner, entry.path)})`));
      return;
    }
    let live = true, url: string | null = null;
    void localFolders().file(owner, entry.path).then(file => {
      if (!live) return;
      if (ADDABLE.includes(entry.kind)) { url = URL.createObjectURL(file); setLocalSrc(url); }
      else if (entry.kind === 'document' && /\.(md|txt|json|csv)$/i.test(entry.name)) void file.slice(0, 4000).text().then(t => { if (live) setText(t); });
      else if (entry.kind === 'font' && file.size <= 8 * 1024 ** 2) void file.arrayBuffer().then(buffer => { if (live) loadFont(new FontFace(family, buffer)); });
    }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [entry, owner, local]);
  if (!entry || !owner) return <div className="ab-preview empty"><span>Select a file to preview it</span></div>;
  const src = local ? localSrc : fileUrl(owner, entry.path), meta = [info?.width ? `${info.width}×${info.height}` : '', clock(info?.durationSeconds), entry.kind === 'image' ? '' : info?.codec?.toUpperCase() ?? '', bytes(info?.size ?? entry.size)].filter(Boolean).join(' · ');
  const duration = info?.durationSeconds ?? 0;
  const measured = (m: HTMLVideoElement | HTMLAudioElement) => { if (local) onMeta({ durationSeconds: Number.isFinite(m.duration) ? m.duration : undefined, ...('videoWidth' in m && m.videoWidth ? { width: m.videoWidth, height: m.videoHeight } : {}) }); };
  return <div className={`ab-preview k-${entry.kind}`}>
    <div className="ab-stage">
      {entry.kind === 'image' ? (local ? (src ? <img src={src} alt={entry.name} onLoad={e => onMeta({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} /> : null) : <img src={/\.svg$/i.test(entry.name) ? src! : thumbUrl(owner, entry.path)} alt={entry.name} />)
        : entry.kind === 'video' ? (src ? <video key={src} ref={media} src={src} poster={!local && entry.thumbnail ? thumbUrl(owner, entry.path) : undefined} muted={!autoPlay} loop playsInline autoPlay onLoadedMetadata={e => measured(e.currentTarget)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={e => { const v = e.currentTarget; if (v.paused) void v.play(); else v.pause(); }} /> : null)
        : entry.kind === 'audio' ? <div className={`ab-wave${local ? ' plain' : ''}`} onClick={e => { const m = media.current, r = e.currentTarget.getBoundingClientRect(); if (m && duration) { m.currentTime = (e.clientX - r.left) / r.width * duration; void m.play().catch(() => {}); } }}>
            {local ? <b aria-hidden="true" /> : <img src={thumbUrl(owner, entry.path)} alt="" onError={ev => { (ev.target as HTMLImageElement).style.visibility = 'hidden'; }} />}<i style={{ left: `${duration ? time / duration * 100 : 0}%` }} />
            {src ? <audio key={src} ref={media} src={src} autoPlay={autoPlay} onLoadedMetadata={e => measured(e.currentTarget)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={e => setTime(e.currentTarget.currentTime)} /> : null}
          </div>
        : entry.kind === 'font' ? <div className="ab-font" style={font ? { fontFamily: font } : undefined}><b>Aa</b><span>The quick brown fox jumps over the lazy dog</span><span>0123456789</span></div>
        : text != null ? <pre className="ab-text">{text}</pre>
        : <div className="ab-none"><Icon name={ICONS[entry.kind]} size={26} /></div>}
    </div>
    <div className="ab-meta"><strong title={entry.path}>{entry.name}</strong><span>{entry.kind === 'folder' ? 'Folder' : meta}</span></div>
    <div className="ab-actions">
      {entry.kind === 'audio' || entry.kind === 'video' ? <button className="ab-play" onClick={() => { const m = media.current; if (m) { if (m.paused) void m.play().catch(() => {}); else m.pause(); } }} aria-label={playing ? 'Pause preview' : 'Play preview'} title={playing ? 'Pause preview' : 'Play preview'}><Icon name={playing ? 'pause' : 'play'} size={14} /></button> : null}
      {entry.kind === 'audio' || entry.kind === 'video' ? <label className="ab-auto" title="Play sound as soon as you select a file"><input type="checkbox" checked={autoPlay} onChange={e => setAutoPlay(e.target.checked)} />Auto-preview</label> : null}
      <span className="ab-spacer" />
      {canAdd(entry) ? <button className="primary ab-addfile" disabled={disabled} onClick={() => add(entry)} title={local ? 'Uploads this file into the Studio library, then adds it' : undefined}>{addLabel(entry.kind)}</button>
        : ADDABLE.includes(entry.kind) ? <span className="ab-cant">Save it as WAV, MP3 or M4A to add it</span> : null}
    </div>
  </div>;
}
