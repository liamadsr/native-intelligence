// The Browser (as in Ableton Live): places on the left, their contents on the right, a preview of the selected file
// underneath. In a workspace there are two fixed places: the Studio library (every video, image and sound already
// imported) and the workspace's own Files (images, video and sound attached to captures, actions and projects).
// Footage, stills and sound can be added to the video with Enter, a double-click, the button, or by dragging them
// out of the Browser onto the editor; a workspace file is imported into the Studio library on the way.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorAsset } from '@/lib/studio/engine/contracts';
import type { EditorJob } from '@/lib/studio/engine/api';
import { finishedJob, request } from './client';
import { Icon, type IconName } from './icons';
import { isMenuKey, useContextMenu, type MenuItem } from './ContextMenu';

export type BrowserKind = 'folder' | 'video' | 'image' | 'audio' | 'font' | 'document' | 'other';
type Place = { id: string; name: string; path: string; available: boolean };
type Entry = { name: string; path: string; kind: BrowserKind; size?: number; thumbnail?: boolean; placeId?: string; placeName?: string };
type Info = { kind: BrowserKind; size: number; width?: number; height?: number; durationSeconds?: number; hasAudio?: boolean; codec?: string };
export type BrowserItem = { place: string; path: string; name: string; kind: BrowserKind };
export const BROWSER_DRAG = 'application/x-ni-studio-browser';
const ADDABLE: BrowserKind[] = ['video', 'image', 'audio'];
const FILTERS: { kind: BrowserKind | null; label: string }[] = [{ kind: null, label: 'All' }, { kind: 'video', label: 'Video' }, { kind: 'image', label: 'Images' }, { kind: 'audio', label: 'Sound' }];
const ICONS: Record<BrowserKind, IconName> = { folder: 'folder', video: 'clip', image: 'image', audio: 'audio', font: 'type', document: 'transcript', other: 'file' };
const q = (place: string, path: string) => `place=${encodeURIComponent(place)}&path=${encodeURIComponent(path)}`;
const thumbUrl = (place: string, path: string) => `/api/account/studio/browser/thumb?${q(place, path)}`;
const fileUrl = (place: string, path: string) => `/api/account/studio/browser/file?${q(place, path)}`;
const addLabel = (kind: BrowserKind) => kind === 'video' ? 'Add clip' : kind === 'image' ? 'Use as background' : 'Add sound';
const bytes = (n?: number) => n == null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
const clock = (s?: number) => s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${s < 60 ? `.${Math.floor((s % 1) * 10)}` : ''}`;
const stored = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
/** Add a Browser item to the Studio library (a library item is answered at once; a workspace file is imported, which may take a while). */
export async function browserImport(item: BrowserItem): Promise<{ asset: EditorAsset }> {
  const answer = await request<{ asset?: EditorAsset; job?: EditorJob }>('/api/account/studio/browser/import', { place: item.place, path: item.path });
  if (answer.asset) return { asset: answer.asset };
  const job = answer.job ? await finishedJob(answer.job.id) : null;
  if (!job?.asset) throw new Error(`${item.name} could not be added.`);
  return { asset: job.asset };
}

export function BrowserPanel({ add, disabled, notify }: { add: (item: BrowserItem) => void; disabled: boolean; notify: (text: string, error?: boolean) => void }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [placeId, setPlaceId] = useState<string | null>(() => stored('ni:studio:browser.place', null));
  const [tree, setTree] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Entry | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [filter, setFilter] = useState<BrowserKind | null>(() => stored('ni:studio:browser.filter', null));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [autoPlay, setAutoPlay] = useState<boolean>(() => stored('ni:studio:browser.autoplay', true));
  const [width, setWidth] = useState<number>(() => stored('ni:studio:browser.w2', 340));
  const openMenu = useContextMenu();
  const listRef = useRef<HTMLDivElement>(null);
  // The editor passes a new notify on every render; read it through a ref so effects don't refetch each time.
  const say = useRef(notify); say.current = notify;
  const fail = useCallback((e: unknown) => say.current((e as Error).message, true), []);
  const place = places.find(p => p.id === placeId) ?? null;

  const loadPlaces = useCallback(async () => {
    const { places } = await request<{ places: Place[] }>('/api/account/studio/browser/places'); setPlaces(places);
    setPlaceId(id => places.some(p => p.id === id) ? id : places[0]?.id ?? null);
  }, []);
  useEffect(() => { void loadPlaces().catch(fail); }, [loadPlaces, fail]);
  useEffect(() => keep('ni:studio:browser.place', placeId), [placeId]);
  useEffect(() => keep('ni:studio:browser.filter', filter), [filter]);
  useEffect(() => keep('ni:studio:browser.autoplay', autoPlay), [autoPlay]);
  useEffect(() => keep('ni:studio:browser.w2', width), [width]);

  const loadFolder = useCallback(async (path: string) => {
    if (!placeId) return;
    const listing = await request<{ entries: Entry[] }>(`/api/account/studio/browser/list?${q(placeId, path)}`);
    setTree(t => ({ ...t, [`${placeId}:${path}`]: listing.entries.map(e => ({ ...e, placeId })) }));
  }, [placeId]);
  // A new place: start at its top level, closed.
  useEffect(() => { setTree({}); setExpanded(new Set()); setSelected(null); setResults(null); if (placeId && place?.available) void loadFolder('').catch(fail); }, [placeId, place?.available, loadFolder, fail]);

  // Search the selected place (or every place when none is selected), as you type.
  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, ...(placeId ? { place: placeId } : {}), ...(filter ? { kind: filter } : {}) });
      void request<{ results: Entry[] }>(`/api/account/studio/browser/search?${params}`).then(r => setResults(r.results)).catch(fail);
    }, 180);
    return () => clearTimeout(timer);
  }, [query, placeId, filter, fail]);

  useEffect(() => {
    setInfo(null); const owner = selected?.placeId ?? placeId;
    if (!selected || !owner || selected.kind === 'folder') return;
    let live = true; void request<Info>(`/api/account/studio/browser/info?${q(owner, selected.path)}`).then(i => { if (live) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, [selected, placeId]);

  const rows = useMemo(() => {
    if (results) return results.map(e => ({ entry: e, depth: 0 }));
    const out: { entry: Entry; depth: number }[] = [];
    const walk = (path: string, depth: number) => { for (const e of tree[`${placeId}:${path}`] ?? []) {
      if (filter && e.kind !== 'folder' && e.kind !== filter) continue;
      out.push({ entry: e, depth }); if (e.kind === 'folder' && expanded.has(e.path)) walk(e.path, depth + 1);
    } };
    walk('', 0); return out;
  }, [tree, expanded, filter, results, placeId]);

  const toggle = (e: Entry, open?: boolean) => {
    const next = new Set(expanded), isOpen = expanded.has(e.path), want = open ?? !isOpen;
    if (want) { next.add(e.path); if (!tree[`${placeId}:${e.path}`]) void loadFolder(e.path).catch(err => notify((err as Error).message, true)); } else next.delete(e.path);
    setExpanded(next);
  };
  const itemFor = (e: Entry): BrowserItem | null => { const owner = e.placeId ?? placeId; return owner ? { place: owner, path: e.path, name: e.name, kind: e.kind } : null; };
  const addEntry = (e: Entry) => { const item = itemFor(e); if (!item || !ADDABLE.includes(e.kind) || disabled) return; add(item); };

  // Right-click menus: a place, and a file in the list.
  const placeMenu = (event: React.MouseEvent | React.KeyboardEvent, p: Place) => openMenu(event as unknown as React.MouseEvent, [
    { label: 'Open', run: () => { setPlaceId(p.id); setQuery(''); }, disabled: p.id === placeId },
  ]);
  const entryMenu = (event: React.MouseEvent | React.KeyboardEvent, e: Entry) => {
    setSelected(e);
    const items: MenuItem[] = [];
    if (ADDABLE.includes(e.kind)) items.push({ label: addLabel(e.kind), run: () => addEntry(e), disabled, hint: '↵' });
    if (e.kind === 'folder' && !results) items.push({ label: expanded.has(e.path) ? 'Close' : 'Open', run: () => toggle(e) });
    if (items.length) openMenu(event as unknown as React.MouseEvent, items);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest('input')) return;
    const at = rows.findIndex(r => r.entry === selected || (selected && r.entry.path === selected.path && r.entry.placeId === selected.placeId));
    const go = (i: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, i))]; if (r) { setSelected(r.entry); listRef.current?.querySelector(`[data-row="${CSS.escape(r.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' }); } };
    if (ev.key === 'ArrowDown') { ev.preventDefault(); go(at + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(at < 0 ? 0 : at - 1); }
    else if (ev.key === 'ArrowRight' && selected?.kind === 'folder' && !results) { ev.preventDefault(); if (!expanded.has(selected.path)) toggle(selected, true); else go(at + 1); }
    else if (ev.key === 'ArrowLeft' && selected && !results) {
      ev.preventDefault();
      if (selected.kind === 'folder' && expanded.has(selected.path)) toggle(selected, false);
      else { const parent = selected.path.split('/').slice(0, -1).join('/'); const r = rows.find(r => r.entry.path === parent); if (r) setSelected(r.entry); }
    }
    else if (ev.key === 'Enter' && selected) { ev.preventDefault(); if (selected.kind === 'folder' && !results) toggle(selected); else addEntry(selected); }
    else if (ev.key === ' ') { ev.preventDefault(); window.dispatchEvent(new CustomEvent('ni-studio-browser-preview-toggle')); }
    else if (isMenuKey(ev) && selected) { ev.preventDefault(); const row = listRef.current?.querySelector(`[data-row="${CSS.escape(selected.path)}"]`); if (row) entryMenu({ ...ev, currentTarget: row, clientX: 0, clientY: 0 } as unknown as React.KeyboardEvent, selected); }
  };

  return <aside className="asset-browser" style={{ width }} aria-label="Browser" onKeyDown={ev => { if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }}>
    <div className="ab-search"><Icon name="search" size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={place ? `Search ${place.name}` : 'Search everything'} aria-label="Search the Browser" onKeyDown={e => { if (e.key === 'Escape') setQuery(''); if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.focus(); if (rows[0]) setSelected(rows[0].entry); } }} />{query ? <button className="ab-clear" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><Icon name="close" size={14} /></button> : null}</div>
    <div className="ab-filters" role="tablist" aria-label="File types">{FILTERS.map(f => <button key={f.label} role="tab" aria-selected={filter === f.kind} className={filter === f.kind ? 'on' : ''} onClick={() => setFilter(f.kind)}>{f.label}</button>)}</div>
    <div className="ab-body">
      <nav className="ab-places" aria-label="Places">
        <div className="ab-head">Places</div>
        {places.map(p => <div key={p.id} className={`ab-place${p.id === placeId ? ' on' : ''}${p.available ? '' : ' missing'}`} title={p.name}
          onContextMenu={event => placeMenu(event, p)}>
          <button onClick={() => { setPlaceId(p.id); setQuery(''); }} onKeyDown={e => { if (isMenuKey(e)) { e.preventDefault(); placeMenu({ ...e, currentTarget: e.currentTarget, clientX: 0, clientY: 0 } as unknown as React.KeyboardEvent, p); } }}>
            <Icon name={p.id === 'files' ? 'folder' : 'clip'} size={14} /><span>{p.name}</span></button>
        </div>)}
      </nav>
      <div className="ab-list" ref={listRef} tabIndex={0} onKeyDown={onKey} role="tree" aria-label={place ? place.name : 'Files'}>
        {!places.length ? <div className="ab-empty"><Icon name="folder" size={22} /><p>Loading…</p></div>
          : place && !place.available && !results ? <div className="ab-empty"><p>“{place.name}” can’t be read just now.</p></div>
          : results && !results.length ? <div className="ab-empty"><p>Nothing matches “{query}”.</p></div>
          : !results && placeId && tree[`${placeId}:`]?.length === 0 ? <div className="ab-empty"><Icon name={placeId === 'files' ? 'folder' : 'clip'} size={22} /><p>{placeId === 'files' ? 'No images, video or sound in the workspace’s files yet.' : 'Nothing in the Studio library yet. Drop footage, stills or sound onto the editor to add them.'}</p></div>
          : rows.map(({ entry: e, depth }) => {
            const owner = e.placeId ?? placeId!, isSel = !!selected && selected.path === e.path && selected.placeId === e.placeId;
            return <div key={`${owner}:${e.path}`} data-row={e.path} role="treeitem" aria-selected={isSel} aria-expanded={e.kind === 'folder' && !results ? expanded.has(e.path) : undefined}
              className={`ab-row k-${e.kind}${isSel ? ' sel' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}
              draggable={ADDABLE.includes(e.kind)} onDragStart={ev => { const item = itemFor(e); if (!item) return; ev.dataTransfer.setData(BROWSER_DRAG, JSON.stringify(item)); ev.dataTransfer.effectAllowed = 'copy'; }}
              onClick={() => { setSelected(e); if (e.kind === 'folder' && !results) toggle(e); listRef.current?.focus(); }} onDoubleClick={() => addEntry(e)}
              onContextMenu={event => { listRef.current?.focus(); entryMenu(event, e); }}>
              {e.kind === 'folder' && !results ? <span className={`ab-tri${expanded.has(e.path) ? ' open' : ''}`} aria-hidden="true"><Icon name="chevronRight" size={12}/></span> : <span className="ab-tri" aria-hidden="true" />}
              {e.thumbnail && e.kind !== 'audio' ? <img className="ab-thumb" loading="lazy" src={thumbUrl(owner, e.path)} alt="" onError={ev => { (ev.target as HTMLImageElement).style.visibility = 'hidden'; }} /> : <span className="ab-icon"><Icon name={ICONS[e.kind]} size={14} /></span>}
              <span className="ab-name">{e.name}{results ? <small>{e.placeName} / {e.path.split('/').slice(0, -1).join('/')}</small> : null}</span>
              {e.size != null && e.kind !== 'folder' ? <span className="ab-size">{bytes(e.size)}</span> : null}
            </div>;
          })}
      </div>
    </div>
    <Preview entry={selected} owner={selected?.placeId ?? placeId} info={info} autoPlay={autoPlay} setAutoPlay={setAutoPlay} add={addEntry} disabled={disabled} />
    <div className="ab-resize" role="separator" aria-orientation="vertical" aria-label="Resize the Browser" onPointerDown={ev => {
      const start = ev.clientX, w = width; (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
      const move = (m: PointerEvent) => setWidth(Math.max(280, Math.min(560, w + m.clientX - start)));
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }} />
  </aside>;
}

/** What the selected file looks or sounds like, plus what can be done with it. */
function Preview({ entry, owner, info, autoPlay, setAutoPlay, add, disabled }: { entry: Entry | null; owner: string | null; info: Info | null; autoPlay: boolean; setAutoPlay: (v: boolean) => void; add: (e: Entry) => void; disabled: boolean }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [text, setText] = useState<string | null>(null), [font, setFont] = useState<string | null>(null);
  useEffect(() => { const t = () => { const m = media.current; if (m) { if (m.paused) void m.play().catch(() => {}); else m.pause(); } }; window.addEventListener('ni-studio-browser-preview-toggle', t); return () => window.removeEventListener('ni-studio-browser-preview-toggle', t); }, []);
  useEffect(() => {
    setText(null); setFont(null); setTime(0);
    if (!entry || !owner) return;
    if (entry.kind === 'document' && /\.(md|txt|json|csv)$/i.test(entry.name)) void fetch(fileUrl(owner, entry.path)).then(r => r.text()).then(t => setText(t.slice(0, 4000))).catch(() => {});
    if (entry.kind === 'font') { const family = `ni-studio-browser-${Math.abs([...entry.path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
      const face = new FontFace(family, `url(${fileUrl(owner, entry.path)})`); void face.load().then(f => { (document.fonts as unknown as { add(face: FontFace): void }).add(f); setFont(family); }).catch(() => setFont(null)); }
  }, [entry, owner]);
  if (!entry || !owner) return <div className="ab-preview empty"><span>Select a file to preview it</span></div>;
  const src = fileUrl(owner, entry.path), meta = [info?.width ? `${info.width}×${info.height}` : '', clock(info?.durationSeconds), entry.kind === 'image' ? '' : info?.codec?.toUpperCase() ?? '', bytes(info?.size ?? entry.size)].filter(Boolean).join(' · ');
  const duration = info?.durationSeconds ?? 0;
  return <div className={`ab-preview k-${entry.kind}`}>
    <div className="ab-stage">
      {entry.kind === 'image' ? <img src={/\.svg$/i.test(entry.name) ? src : thumbUrl(owner, entry.path)} alt={entry.name} />
        : entry.kind === 'video' ? <video key={src} ref={media} src={src} poster={entry.thumbnail ? thumbUrl(owner, entry.path) : undefined} muted={!autoPlay} loop playsInline autoPlay onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={e => { const v = e.currentTarget; if (v.paused) void v.play(); else v.pause(); }} />
        : entry.kind === 'audio' ? <div className="ab-wave" onClick={e => { const m = media.current, r = e.currentTarget.getBoundingClientRect(); if (m && duration) { m.currentTime = (e.clientX - r.left) / r.width * duration; void m.play().catch(() => {}); } }}>
            <img src={thumbUrl(owner, entry.path)} alt="" onError={ev => { (ev.target as HTMLImageElement).style.visibility = 'hidden'; }} /><i style={{ left: `${duration ? time / duration * 100 : 0}%` }} />
            <audio key={src} ref={media} src={src} autoPlay={autoPlay} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={e => setTime(e.currentTarget.currentTime)} />
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
      {ADDABLE.includes(entry.kind) ? <button className="primary ab-addfile" disabled={disabled} onClick={() => add(entry)}>{addLabel(entry.kind)}</button> : null}
    </div>
  </div>;
}
