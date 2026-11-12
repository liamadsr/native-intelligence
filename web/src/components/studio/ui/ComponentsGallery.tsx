import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { request } from './client';
import { StyleGuide } from './StyleGuide';

type Kit = { name: string; title: string; repo: string; available: boolean; curated: number };
type Entry = { id: string; name: string; group: string; help: string; curated: boolean; file: string; width: number; height: number; props?: Record<string, unknown> };
type Stage = { built: boolean; fresh: boolean; key?: string };
type Source = { ref: string; mode: 'branch' | 'working'; sha?: string; subject?: string; committedAt?: string; author?: string; fetchedAt?: string; fetchError?: string; folder_behind?: number; folder_ahead?: number; error?: string };
type Branch = { name: string; date: string; subject: string };
const ago = (iso?: string) => { if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

/** Which code the kit shows: a branch (fetched from GitHub, read straight from git) or the folder as it is on disk. */
function SourceBar({ kit, onChanged, busy, setBusy, fail }: { kit: string; onChanged: () => void; busy: boolean; setBusy: (s: string | null) => void; fail: (e: unknown) => void }) {
  const [info, setInfo] = useState<{ source: Source; branches: Branch[] } | null>(null), [filter, setFilter] = useState('');
  useEffect(() => { let live = true; setInfo(null); void request<{ source: Source; branches: Branch[] }>(`/api/account/studio/kits/${kit}/source`).then(r => { if (live) setInfo(r); }).catch(fail); return () => { live = false; }; }, [kit]);
  const choose = async (ref: string) => { setBusy(ref === 'working' ? 'Switching to the folder on disk…' : `Switching to ${ref}…`);
    try { setInfo(await request(`/api/account/studio/kits/${kit}/source`, { ref })); onChanged(); } catch (e) { fail(e); } finally { setBusy(null); } };
  const check = async () => { setBusy('Checking GitHub for new commits…');
    try { const before = info?.source.sha, next = await request<{ source: Source; branches: Branch[] }>(`/api/account/studio/kits/${kit}/source/refresh`, {}); setInfo(next); if (next.source.sha !== before) onChanged(); } catch (e) { fail(e); } finally { setBusy(null); } };
  if (!info) return <div className="cg-source"><small>Reading the repository…</small></div>;
  const s = info.source, q = filter.trim().toLowerCase(), list = info.branches.filter(b => !q || b.name.toLowerCase().includes(q)).slice(0, 60);
  if (s.ref !== 'working' && !list.some(b => b.name === s.ref)) list.unshift({ name: s.ref, date: s.committedAt ?? '', subject: s.subject ?? '' });
  return <div className="cg-source">
    <label>Shows <select value={s.ref} disabled={busy} onChange={e => void choose(e.target.value)} title="Which code the components come from">
      {list.map(b => <option key={b.name} value={b.name}>{b.name}{b.date ? ` · ${ago(b.date)}` : ''}</option>)}
      <option value="working">Your folder, as it is on disk</option></select></label>
    {info.branches.length > 20 ? <input className="cg-source-filter" placeholder={`Filter ${info.branches.length} branches`} value={filter} onChange={e => setFilter(e.target.value)} /> : null}
    <span className="cg-source-commit">{s.sha ? <code>{s.sha.slice(0, 7)}</code> : null} {s.subject ? <span title={s.subject}>{s.subject}</span> : null}{s.committedAt ? <small> · {ago(s.committedAt)}{s.author ? ` · ${s.author}` : ''}</small> : null}</span>
    {s.mode === 'branch' ? <button onClick={() => void check()} disabled={busy} title={s.fetchedAt ? `Last checked ${ago(s.fetchedAt)}` : 'Check GitHub'}><Icon name="refresh" size={14}/>Check for updates</button> : null}
    <small className="cg-source-note">{s.mode === 'branch'
      ? <>Read straight from git{s.fetchedAt ? `, checked ${ago(s.fetchedAt)}` : ''}. The Studio only downloads: it never changes your branches, files or checkout.{s.folder_behind ? ` Your folder is ${s.folder_behind} commit${s.folder_behind === 1 ? '' : 's'} behind this.` : ''}</>
      : <>Exactly what's on disk{s.error ? ` (${s.error})` : ''}, read-only.</>}
      {s.fetchError ? <span className="warn"> Couldn't reach GitHub ({s.fetchError}); using the last fetched commits.</span> : null}
      {s.mode === 'branch' && s.error ? <span className="warn"> {s.error}</span> : null}</small>
  </div>;
}

type Onboarding = { title: string; components: { total: number; renders: number; featured: number; needsApp: number; needsProps: number; broken: number }; brand: { derived: boolean; site?: string; warnings: string[] }; questions: string[]; next: string[]; failed?: string };

type Job = { id: string; status: string; progress: number; logs: string[]; error?: string; result?: unknown };

/** Components — the person's product, live from its code: attach a repo (read-only), browse every component it exports
 *  rendered for real, try props, and add one to the video at the playhead. Component layers re-render from the code
 *  whenever it changes (Refresh here, and automatically on export). */
const EXAMPLE_SCRIPT = `[
 {"wait": 0.4},
 {"hover": "text=Acme"},
 {"click": "role=button >> nth=0"},
 {"type": "Draft the follow-up", "into": "[contenteditable], textarea, input"},
 {"press": "Enter"}
]`;

export function ComponentsGallery({ projectId, at, disabled, notify, beforeEdit, afterEdit }: { projectId: string; at: number; disabled: boolean;
  notify?: (text: string, error?: boolean) => void; beforeEdit?: () => Promise<boolean>; afterEdit?: () => void }) {
  const [open, setOpen] = useState(false), [kits, setKits] = useState<Kit[] | null>(null), [kit, setKit] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]), [stage, setStage] = useState<Stage | null>(null), [query, setQuery] = useState(''), [pick, setPick] = useState<Entry | null>(null);
  const [script, setScript] = useState(''), [props, setProps] = useState('{}'), [theme, setTheme] = useState<'light' | 'dark'>('light'), [seconds, setSeconds] = useState(6), [replay, setReplay] = useState(0);
  const [stageUrl, setStageUrl] = useState<string | null>(null), [health, setHealth] = useState<Record<string, string> | null>(null), [checking, setChecking] = useState(false), [onlyWorking, setOnlyWorking] = useState(true);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [attach, setAttach] = useState<string | null>(null), [stale, setStale] = useState(0);
  const [view, setView] = useState<'components' | 'style'>('components'), [onboarded, setOnboarded] = useState<Onboarding | null>(null), [room, setRoom] = useState(620), previewRef = useRef<HTMLElement | null>(null);
  useEffect(() => { const el = previewRef.current; if (!el) return; const ro = new ResizeObserver(([e]) => setRoom(Math.max(240, e!.contentRect.width))); ro.observe(el); return () => ro.disconnect(); });
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const loadKits = useCallback(async () => { try { const { kits: list } = await request<{ kits: Kit[] }>('/api/account/studio/kits'); setKits(list); setKit(k => k ?? list[0]?.name ?? null); } catch (e) { fail(e); } }, []);
  const loadCatalog = useCallback(async (name: string) => { try { const r = await request<{ components: Entry[]; stage: Stage; health: Record<string, string> | null; checking: boolean; stageUrl: string | null }>(`/api/account/studio/kits/${name}/catalog`); setEntries(r.components); setStage(r.stage); setHealth(r.health); setChecking(r.checking); setStageUrl(r.stageUrl); setPick(p => p && r.components.some(e => e.id === p.id) ? p : r.components[0] ?? null); } catch (e) { fail(e); } }, []);
  useEffect(() => { if (open) void loadKits(); }, [open, loadKits]);
  useEffect(() => { if (open && kit) void loadCatalog(kit); }, [open, kit, loadCatalog]);
  useEffect(() => { if (!open || !kit || !checking) return; const t = setInterval(() => void loadCatalog(kit), 5000); return () => clearInterval(t); }, [open, kit, checking, loadCatalog]);
  useEffect(() => { void request<{ stale: unknown[] }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/components/status`).then(r => setStale(r.stale.length)).catch(() => setStale(0)); }, [projectId, open]);
  useEffect(() => { setProps(JSON.stringify(pick?.props ?? {}, null, 1)); }, [pick?.id]);
  const build = async () => { if (!kit) return; setBusy('Building the stage from the code…'); setError(null);
    try { const r = await request<{ stage: Stage }>(`/api/account/studio/kits/${kit}/stage`, {}); setStage(r.stage); setReplay(n => n + 1); await loadCatalog(kit); } catch (e) { fail(e); } finally { setBusy(null); } };
  // The code moved on (a new commit on the branch, or edits on disk): rebuild by itself, once per opening.
  const autoBuilt = useRef<string | null>(null);
  useEffect(() => { if (!open || !kit || !stage?.built || stage.fresh || busy || autoBuilt.current === kit) return; autoBuilt.current = kit; void build(); }, [open, kit, stage?.built, stage?.fresh, busy]);
  useEffect(() => { if (!open) autoBuilt.current = null; }, [open]);
  const runJob = async (label: string, path: string, body: unknown) => {
    if (beforeEdit && !await beforeEdit()) { setError('Save your edit first'); return null; }
    setBusy(label); setError(null);
    try { const { job } = await request<{ job: Job }>(path, body);
      for (;;) { await new Promise(d => setTimeout(d, 900)); if (!alive.current) return null; const { job: now } = await request<{ job: Job }>(`/api/account/studio/jobs/${job.id}`);
        if (now.status === 'completed') return now; if (now.status !== 'running') throw new Error(now.error ?? now.status); setBusy(`${label} ${Math.round(now.progress * 100)}% · ${now.logs.at(-1) ?? ''}`); }
    } catch (e) { fail(e); return null; } finally { setBusy(null); }
  };
  const add = async () => { if (!kit || !pick) return; let parsed: Record<string, unknown>, steps: unknown[] | undefined; try { parsed = JSON.parse(props || '{}'); } catch { setError('Props must be JSON'); return; }
    try { steps = script.trim() ? JSON.parse(script) : undefined; if (steps && !Array.isArray(steps)) throw new Error(); } catch { setError('The script must be a JSON list of steps'); return; }
    const done = await runJob('Rendering from the code', `/api/account/studio/projects/${encodeURIComponent(projectId)}/components`, { kit, component: pick.id, props: parsed, ...(steps?.length ? { script: steps } : {}), seconds, theme, at,
      enter: { preset: 'zoom-blur', seconds: 0.5, ease: 'spring' }, exit: { preset: 'blur', seconds: 0.3 }, float: 0.004 });
    if (done) { afterEdit?.(); notify?.(`${pick.name} added at ${at.toFixed(2)} s — it re-renders from the code whenever the product changes`); setOpen(false); } };
  const refresh = async () => { const done = await runJob('Re-rendering from the current code', `/api/account/studio/projects/${encodeURIComponent(projectId)}/components/refresh`, {});
    if (done) { afterEdit?.(); setStale(0); notify?.(String((done.result as { refreshed: number }).refreshed ? `Re-rendered ${(done.result as { refreshed: number }).refreshed} component layer(s) from the current code` : 'Every component layer is current')); } };
  const doAttach = async () => { if (!attach?.trim()) return; setBusy('Attaching…'); setError(null);
    try { const { kit: made } = await request<{ kit: { name: string; title: string } }>('/api/account/studio/kits/attach', { repo: attach.trim() }); setAttach(null); await loadKits(); setKit(made.name);
      // Onboarding runs on the server: build, check which components render, read the style guide. Follow it here.
      for (;;) { await new Promise(d => setTimeout(d, 1500)); if (!alive.current) return;
        const { onboarding } = await request<{ onboarding: { status: string; step: string; report?: Onboarding } }>(`/api/account/studio/kits/${made.name}/onboard`);
        setBusy(`Getting to know ${made.title}: ${onboarding?.step ?? '…'}`);
        if (onboarding && onboarding.status !== 'running') { setOnboarded(onboarding.report ?? null); await loadCatalog(made.name); break; } }
    } catch (e) { fail(e); } finally { setBusy(null); } };
  const shown = useMemo(() => { const q = query.trim().toLowerCase(); return entries.filter(e => (!q || `${e.name} ${e.group} ${e.help}`.toLowerCase().includes(q)) && (e.curated || !onlyWorking || !health || health[e.id] === 'ok')); }, [entries, query, onlyWorking, health]);
  const working = useMemo(() => health ? entries.filter(e => e.curated || health[e.id] === 'ok').length : entries.length, [entries, health]);
  const note = (e: Entry) => { const h = health?.[e.id]; return !h || h === 'ok' ? null : h === 'blank' ? 'needs props' : /must be used within|Provider|inside/i.test(h) ? 'needs the app around it' : 'needs props'; };
  const groups = useMemo(() => { const m = new Map<string, Entry[]>(); for (const e of shown) m.set(e.group, [...(m.get(e.group) ?? []), e]); return [...m]; }, [shown]);
  const frameW = (pick?.width ?? 720) + 48, frameH = (pick?.height ?? 420) + 48, scale = Math.min(1, room / frameW, 420 / frameH);
  let job = ''; try { const steps = (() => { try { const v = script.trim() ? JSON.parse(script) : undefined; return Array.isArray(v) && v.length ? v : undefined; } catch { return undefined; } })();
    job = encodeURIComponent(JSON.stringify({ component: pick?.id, props: JSON.parse(props || '{}'), width: pick?.width, height: pick?.height, theme, pad: 24, preview: true, ...(steps ? { script: steps } : {}) })); } catch { /* invalid props: keep last */ }

  return <div className="tl-menu components-gallery">
    <button disabled={disabled} onClick={() => setOpen(true)} title="Your product's real UI, live from its code — add components to the video"><Icon name="components" size={14}/>Components{stale ? ` · ${stale} to update` : ''}</button>
    {open ? <div className="cg-overlay" role="dialog" aria-label="Components" onPointerDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="cg-panel">
        <header className="cg-head"><b>Components</b>
          <div className="cg-kits">{(kits ?? []).map(k => <button key={k.name} className={k.name === kit ? 'active' : ''} onClick={() => setKit(k.name)} title={k.repo}>{k.title}{k.available ? '' : ' (repo missing)'}</button>)}
            {attach === null ? <button onClick={() => setAttach('')}><Icon name="plus" size={14}/>Attach a repository</button>
              : <span className="cg-attach"><input autoFocus placeholder="~/code/my-app (folder with package.json)" value={attach} onChange={e => setAttach(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void doAttach(); if (e.key === 'Escape') setAttach(null); }} /><button onClick={() => void doAttach()}>Attach</button></span>}</div>
          {stale ? <button className="cg-stale" onClick={() => void refresh()} disabled={!!busy}>The product changed · update {stale} layer{stale === 1 ? '' : 's'}</button> : null}
          <button onClick={() => setOpen(false)} aria-label="Close" title="Close"><Icon name="close"/></button></header>
        {kit ? <nav className="cg-tabs"><button className={view === 'components' ? 'active' : ''} onClick={() => setView('components')}>Components</button><button className={view === 'style' ? 'active' : ''} onClick={() => setView('style')}>Style guide</button></nav> : null}
        {kit ? <SourceBar kit={kit} busy={!!busy} setBusy={setBusy} fail={fail} onChanged={() => { void loadCatalog(kit); void build(); }} /> : null}
        {kit && view === 'style' ? <StyleGuide kit={kit} fail={fail} /> : null}
        {kit && view === 'components' ? <div className="cg-stage">{stage?.built ? (stage.fresh ? <span>Rendering from the current code.</span> : <span className="warn">The code changed since the last build.</span>) : <span>Not built yet.</span>}
          <button onClick={() => void build()} disabled={!!busy}>{stage?.built ? (stage.fresh ? 'Rebuild' : 'Rebuild from the new code') : 'Build from the code'}</button>
          </div> : !kit ? <p className="cg-empty">Attach your product's repository (a React app with Tailwind) to use its real components in videos.</p> : null}
        {onboarded ? <div className="cg-onboarded"><b>{onboarded.title} is attached.</b> {onboarded.failed ? <span className="warn">{onboarded.failed}</span>
          : <>{onboarded.components.renders} of {onboarded.components.total - onboarded.components.featured} components render on their own; {onboarded.components.needsApp} need the app around them, {onboarded.components.needsProps} need data.</>}
          {onboarded.brand.derived ? ` Style guide read${onboarded.brand.site ? ` from ${onboarded.brand.site}` : ' from the code'}.` : ''}
          {onboarded.questions.map(q => <p key={q} className="warn">{q}</p>)}
          <p>Ask the assistant to “onboard {onboarded.title}”: it checks the style guide against the site and sets up the components that need the app around them.</p>
          <button onClick={() => setOnboarded(null)}>OK</button></div> : null}
        {error ? <p className="rec-error" role="alert">{error}</p> : null}{busy ? <p className="cg-busy">{busy}</p> : null}
        {kit && view === 'components' ? <div className="cg-body">
          <aside className="cg-list"><input type="search" placeholder={`Search ${onlyWorking && health ? working : entries.length} components`} value={query} onChange={e => setQuery(e.target.value)} />
            {health ? <label className="cg-filter"><input type="checkbox" checked={onlyWorking} onChange={e => setOnlyWorking(e.target.checked)} /> Only ones that render on their own ({working} of {entries.length})</label>
              : checking ? <small className="cg-filter">Checking which components render on their own…</small> : null}
            <div className="cg-groups">{groups.map(([g, list]) => <section key={g}><h4>{g}</h4>{list.map(e => <button key={e.id} className={pick?.id === e.id ? 'active' : ''} onClick={() => setPick(e)} title={e.file}>{e.name}{e.curated ? <small>{e.help}</small> : note(e) ? <small className="cg-need">{note(e)}</small> : null}</button>)}</section>)}</div></aside>
          <section className="cg-preview" ref={previewRef}>{pick && stage?.built && stageUrl ? <>
            <div className="cg-frame" style={{ width: frameW * scale, height: frameH * scale }}>
              <iframe key={`${pick.id}-${replay}-${stage.key}`} title={pick.name} src={`${stageUrl}#${job}`} style={{ width: frameW, height: frameH, transform: `scale(${scale})`, transformOrigin: '0 0' }} /></div>
            <div className="cg-meta"><b>{pick.name}</b><small>{pick.file}</small>{pick.help ? <p>{pick.help}</p> : null}</div>
            <div className="cg-controls"><button onClick={() => setReplay(n => n + 1)}><Icon name="replay" size={14}/>Replay</button>
              <select value={theme} onChange={e => setTheme(e.target.value as 'light' | 'dark')}><option value="light">Light</option><option value="dark">Dark</option></select>
              <label>Length <input type="number" min={1} max={60} value={seconds} onChange={e => setSeconds(Math.max(1, Math.min(60, Number(e.target.value) || 6)))} /> s</label>
              <button className="primary" disabled={!!busy || disabled} onClick={() => void add()}>Add to the video at {at.toFixed(1)} s</button></div>
            <label className="cg-props"><span>Script <small>what happens on screen: a cursor types, clicks, hovers, scrolls, drags. It plays here and in the video.</small> <button type="button" onClick={() => setScript(EXAMPLE_SCRIPT)}>Example</button></span><textarea rows={4} spellCheck={false} placeholder={EXAMPLE_SCRIPT} value={script} onChange={e => setScript(e.target.value)} onBlur={() => setReplay(n => n + 1)} /></label>
            <label className="cg-props"><span>Props (JSON) <small>sample data read from the app's own types; edit to change what it shows</small> <button type="button" onClick={() => { setProps(JSON.stringify(pick.props ?? {}, null, 1)); setReplay(n => n + 1); }}>Reset</button></span><textarea rows={5} spellCheck={false} value={props} onChange={e => setProps(e.target.value)} onBlur={() => setReplay(n => n + 1)} /></label>
          </> : <p className="cg-empty">{stage?.built ? 'Pick a component.' : 'Build the stage to see the components live.'}</p>}</section>
        </div> : null}
      </div>
    </div> : null}
  </div>;
}
