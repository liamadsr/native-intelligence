import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import type { AppElementSelector, AppProfile, AppProfileBrowse, AppProfileInspect, AppProfileStatus, AppProfileSummary, AppTarget } from '@/lib/studio/engine/api';
import { put, request } from './client';
import { Modal } from './controls';

type ElementDraft = { key: string; id: string; selector: string; repoPath: string; file: string; line: string; sourceRevision: string; note: string; existing: boolean };
type ProfileDraft = { name: string; repoPaths: string[]; kind: AppTarget['kind']; appPath: string; baseUrl: string; width: string; height: string; scale: string; elements: ElementDraft[] };
export type AppProfileEditor = { dirty: () => boolean; save: () => Promise<boolean>; discard: () => void };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const blank = (): ProfileDraft => ({ name: '', repoPaths: [], kind: 'web', appPath: '', baseUrl: 'http://127.0.0.1:3000', width: '1440', height: '900', scale: '1', elements: [] });
const fromProfile = (profile: AppProfile): ProfileDraft => ({
  name: profile.name, repoPaths: [...profile.repoPaths], kind: profile.target.kind,
  appPath: profile.target.kind === 'dial8-desktop' ? profile.target.appPath : '',
  baseUrl: profile.target.kind === 'web' ? profile.target.baseUrl : '',
  width: String(profile.viewport.width), height: String(profile.viewport.height), scale: String(profile.viewport.scale),
  elements: profile.elements.map(element => ({ key: element.id, id: element.id, selector: JSON.stringify(element.selector, null, 2), repoPath: element.source?.repoPath ?? '', file: element.source?.file ?? '', line: element.source?.line === undefined ? '' : String(element.source.line), sourceRevision: element.source?.revision ?? '', note: element.note ?? '', existing: true })),
});

export function profilePayload(draft: ProfileDraft) {
  const name = draft.name.trim();
  if (!name) throw new Error('Name this app profile.');
  const repoPaths = [...new Set(draft.repoPaths.map(path => path.trim()).filter(Boolean))];
  if (!repoPaths.length || repoPaths.length > 4) throw new Error('Choose one to four repository root folders.');
  const target: AppTarget = draft.kind === 'web'
    ? { kind: 'web', baseUrl: draft.baseUrl.trim() }
    : { kind: 'dial8-desktop', appPath: draft.appPath.trim(), bundleId: 'ai.dial8.desktop' };
  if (target.kind === 'web' && !target.baseUrl) throw new Error('Enter the local web app URL.');
  if (target.kind === 'dial8-desktop' && !target.appPath) throw new Error('Choose the Dial8 .app bundle.');
  const width = Number(draft.width), height = Number(draft.height), scale = Number(draft.scale);
  if (!Number.isInteger(width) || width < 320 || width > 4096 || !Number.isInteger(height) || height < 240 || height > 2160 || !Number.isFinite(scale) || scale < 1 || scale > 3) throw new Error('Viewport must be 320–4096 wide, 240–2160 high, with scale from 1 to 3.');
  const seen = new Set<string>();
  const elements = draft.elements.map(element => {
    const id = element.id.trim();
    if (id.length > 100 || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(id) || seen.has(id)) throw new Error(`Element ID ${id || '(empty)'} must be unique and use dot-separated letters, numbers, dashes or underscores.`);
    seen.add(id);
    let selector: AppElementSelector;
    try { selector = JSON.parse(element.selector) as AppElementSelector; } catch { throw new Error(`Selector JSON is invalid for ${id}.`); }
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error(`Selector for ${id} must be a JSON object.`);
    const repoPath = element.repoPath.trim(), file = element.file.trim(), line = element.line.trim(), revision = element.sourceRevision.trim();
    if ((repoPath || file || line || revision) && (!repoPath || !file)) throw new Error(`Source hint for ${id} needs both a repository and relative file.`);
    if (repoPath && !repoPaths.includes(repoPath)) throw new Error(`Source repository for ${id} is not in this profile.`);
    if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`Source file for ${id} must be relative to its repository.`);
    const source = repoPath ? { repoPath, file, ...(line ? { line: Number(line) } : {}), ...(revision ? { revision } : {}) } : undefined;
    if (line && (!Number.isInteger(Number(line)) || Number(line) < 1)) throw new Error(`Source line for ${id} must be a positive whole number.`);
    return { id, selector, ...(source ? { source } : {}), ...(element.note.trim() ? { note: element.note.trim() } : {}) };
  });
  return { name, repoPaths, target, viewport: { width, height, scale }, elements };
}

export function AppsPanel({ profiles, onChanged, onDirtyChange, registerEditor, notify }: {
  profiles: AppProfileSummary[]; onChanged: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
  registerEditor: (editor: AppProfileEditor | null) => void; notify: (text: string, error?: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<AppProfile | null>(null), [status, setStatus] = useState<AppProfileStatus | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(blank), [savedDraft, setSavedDraft] = useState<ProfileDraft>(blank);
  const [busy, setBusy] = useState(false), [inspection, setInspection] = useState<AppProfileInspect | null>(null);
  const [observations, setObservations] = useState<{ id: string; state: string; matches: number }[]>([]);
  const [browseKind, setBrowseKind] = useState<'repo' | 'app' | null>(null), [directory, setDirectory] = useState<AppProfileBrowse | null>(null), [browsePath, setBrowsePath] = useState(''), [browsing, setBrowsing] = useState(false);
  const loadToken = useRef(0), browseToken = useRef(0), current = useRef<{ draft: ProfileDraft; savedDraft: ProfileDraft; profile: AppProfile | null }>({ draft, savedDraft, profile });
  current.current = { draft, savedDraft, profile };
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const discard = useCallback(() => { setDraft(current.current.savedDraft); setInspection(null); setObservations([]); }, []);
  const closeBrowser = useCallback(() => { ++browseToken.current; setBrowseKind(null); }, []);
  const save = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    const starting = current.current;
    let payload: ReturnType<typeof profilePayload>;
    try { payload = profilePayload(starting.draft); } catch (error) { notify(message(error), true); return false; }
    setBusy(true);
    try {
      const result = starting.profile
        ? await put<{ profile: AppProfile; status: AppProfileStatus }>(`/api/account/studio/app-profiles/${encodeURIComponent(starting.profile.id)}`, { expectedRevision: starting.profile.revision, ...payload })
        : await request<{ profile: AppProfile; status: AppProfileStatus }>('/api/account/studio/app-profiles', payload);
      setSelectedId(result.profile.id); setProfile(result.profile); setStatus(result.status);
      const next = fromProfile(result.profile); setSavedDraft(next); if (current.current.draft === starting.draft) setDraft(next); setInspection(null); setObservations([]);
      await onChanged(); notify(`${result.profile.name} saved. Existing project pins remain on their chosen revisions.`);
      return true;
    } catch (error) { notify(message(error), true); return false; } finally { setBusy(false); }
  }, [busy, notify, onChanged]);
  const editor = useRef<AppProfileEditor>({ dirty: () => false, save: async () => false, discard });
  editor.current.dirty = () => JSON.stringify(current.current.draft) !== JSON.stringify(current.current.savedDraft);
  editor.current.save = save; editor.current.discard = discard;
  useEffect(() => { registerEditor(editor.current); return () => registerEditor(null); }, [registerEditor]);

  const choose = async (id: string) => {
    if (dirty) { notify('Save or discard the current app profile edits before opening another profile.', true); return; }
    const token = ++loadToken.current, startingDraft = current.current.draft; setBusy(true);
    try {
      const result = await request<{ profile: AppProfile; status: AppProfileStatus }>(`/api/account/studio/app-profiles/${encodeURIComponent(id)}`);
      if (token !== loadToken.current) return; if (current.current.draft !== startingDraft) { notify('Newer app profile edits arrived while opening; they were preserved.', true); return; }
      const next = fromProfile(result.profile); setSelectedId(id); setProfile(result.profile); setStatus(result.status); setDraft(next); setSavedDraft(next); setInspection(null); setObservations([]);
    } catch (error) { notify(message(error), true); } finally { if (token === loadToken.current) setBusy(false); }
  };
  const create = () => { if (dirty) { notify('Save or discard the current app profile edits before creating another profile.', true); return; } ++loadToken.current; const next = blank(); setSelectedId(null); setProfile(null); setStatus(null); setDraft(next); setSavedDraft(next); setInspection(null); setObservations([]); };
  const browse = async (path?: string) => { const token = ++browseToken.current; setBrowsing(true); try { const result = await request<AppProfileBrowse>('/api/account/studio/app-profiles/browse', path ? { path } : {}); if (token === browseToken.current) { setDirectory(result); setBrowsePath(result.path); } } catch (error) { if (token === browseToken.current) notify(message(error), true); } finally { if (token === browseToken.current) setBrowsing(false); } };
  const openBrowser = (kind: 'repo' | 'app') => { setBrowseKind(kind); setDirectory(null); setBrowsePath(''); void browse(); };
  const addPath = (path: string) => { setDraft(value => ({ ...value, repoPaths: value.repoPaths.includes(path) ? value.repoPaths : [...value.repoPaths, path] })); setInspection(null); setBrowseKind(null); };
  const chooseApp = (path: string) => { setDraft(value => ({ ...value, appPath: path })); setInspection(null); setBrowseKind(null); };
  const inspect = async () => { const repoPaths=[...new Set(draft.repoPaths.map(path=>path.trim()).filter(Boolean))],target:AppTarget=draft.kind==='web'?{kind:'web',baseUrl:draft.baseUrl.trim()}:{kind:'dial8-desktop',appPath:draft.appPath.trim(),bundleId:'ai.dial8.desktop'}; if(!repoPaths.length){notify('Choose a repository folder before checking paths.',true);return;} setBusy(true); try { setInspection(await request<AppProfileInspect>('/api/account/studio/app-profiles/inspect', { repoPaths, target })); } catch (error) { notify(message(error), true); } finally { setBusy(false); } };
  const validate = async () => { if (!profile || dirty || profile.target.kind !== 'web') return; setBusy(true); try { const result = await request<{ status: AppProfileStatus; observations: { id: string; state: string; matches: number }[] }>(`/api/account/studio/app-profiles/${encodeURIComponent(profile.id)}/validate`, { expectedRevision: profile.revision }); setStatus(result.status); setObservations(result.observations); notify('Read-only element check finished. No clicks or typing were sent.'); } catch (error) { notify(message(error), true); } finally { setBusy(false); } };
  const editElement = (key: string, patch: Partial<ElementDraft>) => setDraft(value => ({ ...value, elements: value.elements.map(element => element.key === key ? { ...element, ...patch } : element) }));
  return <div className="apps-panel"><div className="automation-panel-status"><span>{dirty ? 'App setup has unsaved changes' : 'App setups saved locally'}</span><button className="subtle-button" disabled={!dirty || busy} onClick={() => void save()}>Save app setup</button></div>
    <div className="app-profile-workspace"><div className="app-profile-collection"><h2>Saved apps</h2><p className="hint">Choose an app to edit its reusable setup. Nothing launches or records when you choose it.</p>
    <div className="script-actions"><button disabled={busy} onClick={create}><Icon name="plus" size={14}/>Connect an app</button><button disabled={busy} onClick={() => void onChanged()}>Refresh apps</button><button disabled={!dirty || busy} onClick={discard}>Discard edits</button></div>
    <div className="app-profile-list" aria-label="Saved app profiles">{profiles.map(item => <button key={item.id} disabled={busy} className={selectedId === item.id ? 'active' : ''} onClick={() => void choose(item.id)}><strong>{item.name}</strong><small>{item.targetKind === 'web' ? 'Local web app' : 'Dial8 desktop'}{item.stale ? ' · source changed' : ''}</small></button>)}{!profiles.length ? <p className="hint">No app profiles saved yet.</p> : null}</div></div><div className="app-profile-main"><fieldset className="app-profile-editor" disabled={busy}><h2>{profile ? `Edit ${profile.name}` : 'Connect an app'}</h2><p className="hint">Choose the app and its source folders. Save here, then select it for a video project.</p>
      <label className="field"><span className="field-label">App name</span><input aria-label="App profile name" value={draft.name} maxLength={200} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} placeholder="e.g. Dial8 staging"/></label>
      <label className="field"><span className="field-label">Target</span><select aria-label="App target kind" value={draft.kind} onChange={event => { setDraft(value => ({ ...value, kind: event.target.value as AppTarget['kind'] })); setInspection(null); }}><option value="web">Local web app</option><option value="dial8-desktop">Dial8 desktop app</option></select></label>
      {draft.kind === 'web' ? <label className="field"><span className="field-label">Local app URL</span><input aria-label="Local web app URL" value={draft.baseUrl} onChange={event => { setDraft(value => ({ ...value, baseUrl: event.target.value })); setInspection(null); }} placeholder="http://127.0.0.1:3000"/><small className="hint">The app must already be running on this Mac. Profile selection does not start it. Use numeric 127.0.0.1 or [::1], not a hostname.</small></label>
        : <div className="field"><span className="field-label">Dial8 desktop app</span><div className="app-path-row"><span className="app-path-selected">{draft.appPath.split('/').filter(Boolean).at(-1)??'No app chosen'}</span><button className="subtle-button" onClick={() => openBrowser('app')}>Choose app</button></div><details className="app-path-manual"><summary>Enter app path manually</summary><input aria-label="Dial8 app path" value={draft.appPath} onChange={event => { setDraft(value => ({ ...value, appPath: event.target.value })); setInspection(null); }} placeholder="/Applications/Dial8.app"/></details><small className="hint">This uses the existing Dial8 helper. Other desktop apps are not available yet.</small></div>}
      <h3>Source code</h3><p className="hint">Help your agent find controls in this app. Choose its Git repository folders; nothing is uploaded.</p>
      {draft.repoPaths.map(path => <div className="app-path-item" key={path}><div className="app-path-name"><span title={path}>{path.split('/').filter(Boolean).at(-1)??path}</span><details><summary>Folder path</summary><code>{path}</code></details></div><button aria-label={`Remove repository ${path}`} onClick={() => { setDraft(value => ({ ...value, repoPaths: value.repoPaths.filter(item => item !== path) })); setInspection(null); }} title={`Remove repository ${path}`}><Icon name="close" size={14}/></button></div>)}
      <button className="full-button" disabled={draft.repoPaths.length>=4} onClick={() => openBrowser('repo')}><Icon name="plus" size={14}/>Choose source folder</button>
      <div className="app-profile-actions"><button className="subtle-button" disabled={busy} onClick={() => void inspect()}>Check setup</button><button className="primary" disabled={busy || !dirty} onClick={() => void save()}>Save app setup</button></div>
      {inspection ? <p className={inspection.ready ? 'app-profile-status' : 'inline-warning'} role="status">{inspection.ready ? 'Source folders are available; app connection is configured.' : 'Some configured paths are unavailable.'} This check does not verify web reachability or selectors, or launch the app.{inspection.repos.filter(repo => !repo.available).map(repo => <span key={repo.path}> {repo.path}: {repo.error ?? 'unavailable'}.</span>)}{inspection.target.reason ? <span> {inspection.target.reason}</span> : null}</p> : null}
      {status ? <p className="app-profile-status" role="status">Saved target: {status.target.available ? profile?.target.kind === 'web' ? 'URL configured' : 'app path available' : status.target.reason ?? 'unavailable'} · Source folders: {status.repos.length}{status.stale ? ' · source changed since profile was saved' : ''}. Checking saved controls is a separate action.</p> : null}
      <details className="app-profile-advanced"><summary>For agents and capture setup · {draft.elements.length} named controls</summary>{profile ? <p className="hint">Profile ID: <code>{profile.id}</code><br/>Saved revision: <code>{profile.revision.slice(0, 12)}</code></p> : null}<h3>Capture size</h3><div className="app-viewport-fields"><label>Width<input aria-label="App viewport width" type="number" min="1" value={draft.width} onChange={event => setDraft(value => ({ ...value, width: event.target.value }))}/></label><label>Height<input aria-label="App viewport height" type="number" min="1" value={draft.height} onChange={event => setDraft(value => ({ ...value, height: event.target.value }))}/></label><label>Scale<input aria-label="App viewport scale" type="number" min="0.1" step="0.1" value={draft.scale} onChange={event => setDraft(value => ({ ...value, scale: event.target.value }))}/></label></div>
      <h3>Named elements</h3><p className="hint">Stable IDs can be reused as <code>elementRef</code> in capture scripts. Write a locator JSON object such as <code>{'{"role":"button","name":"New chat"}'}</code>. Repository hints help the agent rediscover code; only an explicit live check verifies visible matches. Changing an ID creates a new reference in the next profile revision; scripts pinned to an older revision keep their original IDs.</p>
      {draft.elements.map(element => { const result = observations.find(item => item.id === element.id), savedState = status?.elements.find(item => item.id === element.id); return <div className="app-element" key={element.key}><div className="app-element-heading"><strong>{element.id || 'New element'}</strong><span>{result ? `${result.state} · ${result.matches} match${result.matches === 1 ? '' : 'es'}` : savedState?.state ?? 'unvalidated'}</span></div><label className="field"><span className="field-label">Stable element ID</span><input aria-label="Stable element ID" value={element.id} onChange={event => editElement(element.key, { id: event.target.value })} placeholder="capture-row"/></label><label className="field"><span className="field-label">Selector JSON</span><textarea aria-label={`Selector JSON for ${element.id || 'new element'}`} rows={3} value={element.selector} onChange={event => editElement(element.key, { selector: event.target.value })}/></label><label className="field"><span className="field-label">Source repository</span><select aria-label={`Source repository for ${element.id || 'new element'}`} value={element.repoPath} onChange={event => editElement(element.key, event.target.value ? { repoPath: event.target.value } : { repoPath: '', file: '', line: '', sourceRevision: '' })}><option value="">No source hint</option>{draft.repoPaths.map(path => <option key={path} value={path}>{path}</option>)}</select></label>{element.repoPath ? <div className="number-pair"><label>Relative file<input aria-label={`Source file for ${element.id || 'new element'}`} value={element.file} onChange={event => editElement(element.key, { file: event.target.value })} placeholder="src/components/Capture.tsx"/></label><label>Line<input aria-label={`Source line for ${element.id || 'new element'}`} type="number" min="1" value={element.line} onChange={event => editElement(element.key, { line: event.target.value })}/></label></div> : null}{element.repoPath ? <label className="field"><span className="field-label">Source revision (optional)</span><input aria-label={`Source revision for ${element.id || 'new element'}`} value={element.sourceRevision} onChange={event => editElement(element.key, { sourceRevision: event.target.value })} placeholder="Commit or worktree fingerprint"/></label> : null}<label className="field"><span className="field-label">Note</span><input aria-label={`Note for ${element.id || 'new element'}`} value={element.note} onChange={event => editElement(element.key, { note: event.target.value })} placeholder="Why this locator is stable"/></label><button className="subtle-button" onClick={() => setDraft(value => ({ ...value, elements: value.elements.filter(item => item.key !== element.key) }))}>Remove element</button></div>; })}
      <button className="full-button" onClick={() => setDraft(value => ({ ...value, elements: [...value.elements, { key: crypto.randomUUID(), id: '', selector: '{\n  "role": "button",\n  "name": ""\n}', repoPath: '', file: '', line: '', sourceRevision: '', note: '', existing: false }] }))}><Icon name="plus" size={14}/>Add named element</button>
      {profile?.target.kind === 'web' ? <><button className="full-button" disabled={busy || dirty || !profile.elements.length} onClick={() => void validate()}>Check saved elements in running web app</button><p className="hint">Read-only check: opens the local URL in a fresh unauthenticated browser and counts visible matches. It does not click, type, capture or change this video project.</p></> : <p className="hint">Dial8 desktop elements are checked during an explicitly authorized capture, not by opening the app here.</p>}
      </details>
    </fieldset></div></div>
    {browseKind ? <Modal title={browseKind === 'repo' ? 'Choose repository folder' : 'Choose Dial8 .app'} close={closeBrowser}><p>Browse local paths without uploading or copying files.</p><form className="model-path-row" onSubmit={event => { event.preventDefault(); void browse(browsePath); }}><input aria-label="Browse app profile directory" value={browsePath} onChange={event => setBrowsePath(event.target.value)} placeholder="Absolute directory path"/><button disabled={browsing}>Open</button></form><div className="model-directory-heading"><span>{directory?.path ?? 'Home'}</span><button disabled={browsing || !directory?.parentPath} onClick={() => directory?.parentPath && void browse(directory.parentPath)}>Parent folder</button></div>{browsing ? <p role="status">Reading directory metadata…</p> : null}<div className="model-directory-list">{directory?.entries.map(entry => <button key={entry.path} disabled={browsing || browseKind === 'repo' && entry.kind === 'app'} onClick={() => { if (entry.kind === 'app') chooseApp(entry.path); else void browse(entry.path); }}><span>{entry.kind === 'app' ? 'App ' : <Icon name="folder" size={14}/>}{entry.name}</span></button>)}{directory && !directory.entries.length ? <p className="hint">No folders or app bundles here.</p> : null}</div>{directory?.truncated ? <p className="hint">Listing truncated; enter a narrower folder path.</p> : null}<div className="modal-actions"><button onClick={closeBrowser}>Cancel</button>{browseKind === 'repo' ? <button className="primary" disabled={!directory || browsing} onClick={() => directory && addPath(directory.path)}>Use this folder</button> : null}</div></Modal> : null}
  </div>;
}
