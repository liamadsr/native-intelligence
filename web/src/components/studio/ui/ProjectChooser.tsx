import { studioKeys } from '../studio-env';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CampaignSummary, ProjectSummary } from '@/lib/studio/engine/api';
import { adShapes, ratio, statusLabel } from './project-shapes';
import { request, remove } from './client';
import { isMenuKey, useContextMenu } from './ContextMenu';
import { Icon } from './icons';
import { rememberPage } from './FilmPages';

type Props = {
  currentProjectId: string | null; currentTitle?: string; refreshKey: string; disabled: boolean;
  /** Esc goes back to the video only when there is one to go back to. */
  canClose: boolean; close: () => void;
  onProject: (id: string) => void; onRecord: () => void; onNew: () => void; onRenameCurrent: (title: string) => void; onDeleted: (id: string, remaining: ProjectSummary[]) => void;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const length = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60); if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24); if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Thumb({ project }: { project: ProjectSummary }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [project.updatedAt]);
  return <span className="chooser-thumb">{failed ? <span className="chooser-thumb-empty" aria-hidden="true"><Icon name="clip" size={22} /></span>
    : <img alt="" loading="lazy" src={`/api/account/studio/projects/${encodeURIComponent(project.id)}/thumbnail.jpg?v=${encodeURIComponent(project.updatedAt)}`} onError={() => setFailed(true)} />}</span>;
}

/** The project chooser (Logic Pro style), the Studio rail's Projects and videos page (AppRail.tsx), drawn beside the rail as a page of the Studio, not a dialog: ways to start on the left (New recording, New blank video, New Studio project); on the right, projects (a campaign: many ads with
 *  the same people and brand) as groups of their ads, then single videos. Click selects, double-click or Open opens;
 *  right-click (or the menu key) has Open, Rename, Duplicate, Move to a project, status and Delete (to the trash).
 *  Drag a video onto a project to file it there, or onto another single video to make a project of the two. */
export function ProjectChooser({ currentProjectId, currentTitle, refreshKey, disabled, canClose, close, onProject, onRecord, onNew, onRenameCurrent, onDeleted }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]), [renamingGroup, setRenamingGroup] = useState<{ id: string; title: string } | null>(null), [dropOn, setDropOn] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [error, setError] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(currentProjectId);
  const [menu, setMenu] = useState<string | null>(null), [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null), [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openMenu = useContextMenu();
  const epoch = useRef(0), search = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const mine = ++epoch.current;
    try { const [result, grouped] = await Promise.all([request<{ projects: ProjectSummary[] }>('/api/account/studio/projects'), request<{ campaigns: CampaignSummary[] }>('/api/account/studio/campaigns')]);
      if (mine === epoch.current) { setProjects(result.projects); setCampaigns(grouped.campaigns); setError(null); } }
    catch (cause) { if (mine === epoch.current) setError(message(cause)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; search.current?.focus(); return () => { previous?.focus?.(); }; }, []);
  const titled = <T extends ProjectSummary>(p: T): T => p.id === currentProjectId && currentTitle ? { ...p, title: currentTitle } : p;
  const { groups, singles, rows } = useMemo(() => {
    const q = query.trim().toLowerCase(), hit = (title: string, group?: string) => !q || title.toLowerCase().includes(q) || !!group?.toLowerCase().includes(q);
    const groups = campaigns.filter(c => !c.single).map(c => ({ ...c, ads: c.ads.filter(a => !a.variantOf).map(titled).filter(a => hit(a.title, c.title)), outputs: c.ads.filter(a => a.variantOf) }))
      .filter(c => c.ads.length || (!q && !c.ads.length));
    const singles = campaigns.filter(c => c.single).map(c => titled(c.ads[0]!)).filter(a => hit(a.title));
    return { groups, singles, rows: [...groups.flatMap(g => g.ads), ...singles] };
  }, [campaigns, query, currentProjectId, currentTitle]);
  const groupOf = (adId: string) => campaigns.find(c => !c.single && c.ads.some(a => a.id === adId)) ?? null;
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(null); try { await fn(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const commitRename = () => {
    const target = renaming; setRenaming(null);
    if (!target || !target.title.trim()) return;
    if (target.id === currentProjectId) { onRenameCurrent(target.title.trim()); return; }
    void act(async () => { await request(`/api/account/studio/projects/${encodeURIComponent(target.id)}/rename`, { title: target.title.trim() }); await refresh(); });
  };
  const open = (id: string) => { setMenu(null); if (disabled) return; if (id === currentProjectId) { if (canClose) close(); return; } onProject(id); };
  const duplicate = (id: string) => void act(async () => { setMenu(null); const { project } = await request<{ project: { id: string } }>(`/api/account/studio/projects/${encodeURIComponent(id)}/duplicate`, {}); await refresh(); setSelected(project.id); onProject(project.id); });
  const destroy = (id: string) => void act(async () => { setMenu(null); setConfirming(null); const { projects: remaining } = await remove<{ projects: ProjectSummary[] }>(`/api/account/studio/projects/${encodeURIComponent(id)}`); setProjects(remaining); onDeleted(id, remaining); });
  const cardMenu = (event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault?: () => void }, p: ProjectSummary) => {
    setSelected(p.id); const home = groupOf(p.id);
    openMenu(event, [
      { label: p.id === currentProjectId ? 'Back to this video' : 'Open', run: () => open(p.id), disabled, hint: '↵' },
      { label: 'Rename', run: () => setRenaming({ id: p.id, title: p.title }) },
      { label: 'Duplicate', run: () => duplicate(p.id), disabled: disabled || busy },
      ...(home ? [{ separator: true } as const, ...(['draft', 'review', 'approved'] as const).map(status => ({ label: `Mark as ${statusLabel[status].toLowerCase()}`, run: () => void act(async () => { await request(`/api/account/studio/projects/${encodeURIComponent(p.id)}/status`, { status }); await refresh(); }), disabled: home.ads.find(a => a.id === p.id)?.status === status }))] : []),
      { separator: true },
      ...campaigns.filter(c => !c.single && c.id !== home?.id).slice(0, 8).map(c => ({ label: `Move to ${c.title}`, run: () => moveTo(c.id, p.id, event) })),
      { label: home ? 'Move to a new Studio project' : 'Make it a Studio project', run: () => void act(async () => { const { campaign } = await request<{ campaign: CampaignSummary }>('/api/account/studio/campaigns', { title: home ? p.title : p.title, projectIds: [p.id] }); await refresh(); setRenamingGroup({ id: campaign.id, title: campaign.title }); }) },
      ...(home ? [{ label: `Take out of ${home.title}`, run: () => void act(async () => { await request(`/api/account/studio/projects/${encodeURIComponent(p.id)}/unfile`, {}); await refresh(); }) }] : []),
      { separator: true },
      { label: 'Delete…', danger: true, run: () => destroy(p.id), disabled: busy, confirm: { text: `Delete “${p.title}”? It moves to the trash.`, action: 'Delete' } },
    ]);
  };
  const moveTo = (campaignId: string, adId: string, at?: { clientX: number; clientY: number }) => {
    const go = () => void act(async () => { await request(`/api/account/studio/campaigns/${encodeURIComponent(campaignId)}/ads`, { projectId: adId }); await refresh(); });
    const ad = (projects ?? []).find(p => p.id === adId), target = campaigns.find(c => c.id === campaignId);
    const name = target ? (target.single ? `a new Studio project with “${target.ads[0]?.title}”` : `“${target.title}”`) : 'that Studio project';
    if (!ad?.castCount) { go(); return; }
    // The project's ads share one cast, so the video's people join every ad there: say so before it happens.
    openMenu({ clientX: at?.clientX ?? innerWidth / 2, clientY: at?.clientY ?? innerHeight / 3 }, [{ label: `Move to ${target?.single ? 'a new Studio project' : target?.title ?? 'Studio project'}`, run: go,
      confirm: { text: `“${ad.title}” has a cast of ${ad.castCount}. Moving it into ${name} shares them with every video there.`, action: 'Move', immediate: true } }]);
  };
  const commitGroupRename = () => { const r = renamingGroup; setRenamingGroup(null); if (r?.title.trim()) void act(async () => { await request(`/api/account/studio/campaigns/${encodeURIComponent(r.id)}`, { title: r.title.trim() }); await refresh(); }); };
  const newAd = (event: { clientX: number; clientY: number; currentTarget?: EventTarget | null }, c: CampaignSummary) => openMenu(event, [
    ...adShapes.map(shape => ({ label: `Blank ${shape.label}`, run: () => void act(async () => { const { project } = await request<{ project: { id: string } }>(`/api/account/studio/campaigns/${encodeURIComponent(c.id)}/new-ad`, { width: shape.width, height: shape.height, title: `${c.title} · new video` }); await refresh(); onProject(project.id); }), disabled })),
    ...(c.ads[0] ? [{ separator: true } as const, { label: `Copy of ${c.ads[0].title}`, run: () => void act(async () => { const { project } = await request<{ project: { id: string } }>(`/api/account/studio/campaigns/${encodeURIComponent(c.id)}/new-ad`, { from: c.ads[0]!.id }); await refresh(); onProject(project.id); }), disabled }] : []),
  ]);
  /** A new Studio project with its first video, in the shape picked, opened on the project's overview (where it is named). */
  const newStudioProject = (event: { clientX: number; clientY: number; currentTarget?: EventTarget | null }) => openMenu(event, adShapes.map(shape => ({ label: `First video: ${shape.label}`, disabled, run: () => void act(async () => {
    const { campaign } = await request<{ campaign: { id: string } }>('/api/account/studio/campaigns', { title: 'Untitled Studio project', projectIds: [] });
    const { project } = await request<{ project: { id: string } }>(`/api/account/studio/campaigns/${encodeURIComponent(campaign.id)}/new-ad`, { width: shape.width, height: shape.height, title: 'Untitled video' });
    rememberPage(project.id, 'project'); await refresh(); onProject(project.id);
  }) })));
  const groupMenu = (event: React.MouseEvent, c: CampaignSummary) => openMenu(event, [
    { label: 'Rename Studio project', run: () => setRenamingGroup({ id: c.id, title: c.title }) },
    { label: 'New video…', run: () => newAd(event, c) },
    { separator: true },
    { label: 'Ungroup', danger: true, run: () => void act(async () => { await request(`/api/account/studio/campaigns/${encodeURIComponent(c.id)}/dissolve`, {}); await refresh(); }), confirm: { text: `Ungroup “${c.title}”? Its videos stay, each on its own. Its notes and brand are removed.`, action: 'Ungroup' } },
  ]);
  // Drag a video onto a project, or onto another single video to make a project of the two.
  const AD_DRAG = 'application/x-ni-studio-ad';
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(AD_DRAG)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropOn(target); } },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropOn(d => d === target ? null : d); },
    onDrop: (e: React.DragEvent) => { const ad = e.dataTransfer.getData(AD_DRAG); setDropOn(null); if (!ad) return; e.preventDefault(); e.stopPropagation();
      const single = target.startsWith('single-') ? target.slice('single-'.length) : null; if (ad === single || groupOf(ad)?.id === target) return; moveTo(target, ad, e); },
  });
  // Esc steps back one level: rename, then the ⋯ menu, then the chooser itself (when a project is open behind it). Tab is
  // not held inside: the chooser is a page of the Studio, and the rail beside it (first in the reading order) stays usable.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (renaming) setRenaming(null); else if (renamingGroup) setRenamingGroup(null); else if (menu) { setMenu(null); setConfirming(null); } else if (canClose) close(); return; }
    };
    studioKeys.addEventListener('keydown', key); return () => studioKeys.removeEventListener('keydown', key);
  }, [renaming, renamingGroup, menu, canClose, close]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.chooser-menu,.chooser-more')) { setMenu(null); setConfirming(null); } };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const chosen = rows.find(p => p.id === selected) ?? null;
  const gridKey = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input,.chooser-menu')) return;
    if (event.key === 'Enter' && chosen) { event.preventDefault(); open(chosen.id); return; }
    const columns = Math.max(1, Math.round((event.currentTarget as HTMLElement).clientWidth / 236)), step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (!step || !rows.length) return; event.preventDefault();
    const at = Math.max(0, Math.min(rows.length - 1, (chosen ? rows.indexOf(chosen) : -1) + step)); setSelected(rows[at]!.id);
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.chooser-card')[at]?.focus();
  };

  const card = (p: ProjectSummary, outputs: ProjectSummary[], status: string | undefined) => {
    const current = p.id === currentProjectId, on = p.id === selected;
    return <div key={p.id} role="option" aria-selected={on} tabIndex={on || (!chosen && p === rows[0]) ? 0 : -1} draggable={!renaming}
      className={`chooser-card${on ? ' selected' : ''}${dropOn === `single-${p.id}` ? ' drop' : ''}`}
      onDragStart={e => { e.dataTransfer.setData(AD_DRAG, p.id); e.dataTransfer.effectAllowed = 'move'; }}
      {...(groupOf(p.id) ? {} : dropProps(`single-${p.id}`))}
      onClick={e => { if ((e.target as HTMLElement).closest('input,.chooser-output')) return; if (on && (e.target as HTMLElement).closest('.chooser-title') && !disabled) { setRenaming({ id: p.id, title: p.title }); return; } setSelected(p.id); }}
      onDoubleClick={e => { if ((e.target as HTMLElement).closest('input,.chooser-output')) return; open(p.id); }}
      onContextMenu={e => { if ((e.target as HTMLElement).closest('input')) return; cardMenu(e, p); }}
      onKeyDown={e => { if (isMenuKey(e)) { e.preventDefault(); e.stopPropagation(); cardMenu({ clientX: 0, clientY: 0, currentTarget: e.currentTarget }, p); } }}>
      <Thumb project={p} />
      {current ? <span className="chooser-open-badge">Open now</span> : null}
      {status && status !== 'draft' ? <span className={`chooser-status ${status}`}>{statusLabel[status as keyof typeof statusLabel]}</span> : null}
      <div className="chooser-card-text">
        {renaming?.id === p.id ? <input className="chooser-rename" autoFocus aria-label="Video name" value={renaming.title} maxLength={250}
          onFocus={e => e.currentTarget.select()} onChange={e => setRenaming({ id: p.id, title: e.target.value })} onBlur={commitRename}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); } }} />
          : <span className="chooser-title" title={p.title}>{p.title}</span>}
        <span className="chooser-meta">{ratio(p.width, p.height)} · {length(p.durationSeconds)} · {ago(p.updatedAt)}{p.hasSlides ? ' · slides' : ''}</span>
        {outputs.length ? <span className="chooser-outputs">{outputs.map(o => <button key={o.id} className="chooser-output" title={`Open the ${ratio(o.width, o.height)} version`} onClick={() => open(o.id)}>{ratio(o.width, o.height)}</button>)}</span> : null}
      </div>
    </div>;
  };

  return <div className="chooser-backdrop">
    <section className="chooser" aria-label="Projects and videos" data-studio-chooser="">
      <aside className="chooser-side">
        <div className="chooser-brand"><span className="chooser-brand-mark"><span /></span><strong>Studio</strong></div>
        <span className="chooser-side-label">New</span>
        <button className="chooser-start record" disabled={disabled} onClick={onRecord}><span className="chooser-start-icon"><span className="rec-dot" /></span><span><b>New recording</b><small>Your app, slides and camera in one take</small></span></button>
        <button className="chooser-start" disabled={disabled} onClick={onNew}><span className="chooser-start-icon"><Icon name="plus" size={16} /></span><span><b>New blank video</b><small>A canvas of any shape. Describe it and the agent builds it</small></span></button>
        <button className="chooser-start" data-chooser-start="studio-project" disabled={disabled || busy} onClick={newStudioProject}><span className="chooser-start-icon"><Icon name="stack" size={16} /></span><span><b>New Studio project</b><small>Videos that share their people, brand and media</small></span></button>
        <p className="chooser-side-note">Studio projects, videos and their media are kept in this workspace.</p>
      </aside>
      <section className="chooser-main">
        <header className="chooser-head">
          <div><h2>Projects and videos</h2>{projects ? <span>{groups.length ? `${groups.length} Studio project${groups.length === 1 ? '' : 's'} · ` : ''}{projects.length} video{projects.length === 1 ? '' : 's'} in this workspace · newest first</span> : <span>Loading…</span>}</div>
          <input ref={search} className="chooser-search" type="search" placeholder="Search videos" aria-label="Search videos" value={query} onChange={e => setQuery(e.target.value)} />
        </header>
        {error ? <p className="rec-error chooser-error" role="alert">{error}</p> : null}
        <div className="chooser-groups" role="listbox" aria-label="Projects and videos" onKeyDown={gridKey}>
          {groups.map(c => <section key={c.id} className={`chooser-group${dropOn === c.id ? ' drop' : ''}`} aria-label={c.title} {...dropProps(c.id)}>
            <header className="chooser-group-head" onContextMenu={e => groupMenu(e, c)}>
              {renamingGroup?.id === c.id ? <input className="chooser-rename group" autoFocus aria-label="Studio project name" value={renamingGroup.title} maxLength={160}
                onFocus={e => e.currentTarget.select()} onChange={e => setRenamingGroup({ id: c.id, title: e.target.value })} onBlur={commitGroupRename}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitGroupRename(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingGroup(null); } }} />
                : <h3 title="Right-click to rename or ungroup" onDoubleClick={() => setRenamingGroup({ id: c.id, title: c.title })}>{c.title}</h3>}
              <span>{c.ads.length} video{c.ads.length === 1 ? '' : 's'}{c.outputs.length ? ` · ${c.outputs.length} more format${c.outputs.length === 1 ? '' : 's'}` : ''}{c.castCount ? ` · cast of ${c.castCount}` : ''}</span>
              <button className="chooser-group-new" disabled={disabled || busy} onClick={e => newAd(e, c)}><Icon name="plus" size={14} />New video</button>
            </header>
            <div className="chooser-grid">{c.ads.map(p => card(p, c.outputs.filter(o => o.variantOf === p.id), c.ads.find(a => a.id === p.id)?.status))}
              {!c.ads.length ? <div className="chooser-group-empty">No videos yet. Drag a video here, or make a new one.</div> : null}</div>
          </section>)}
          {singles.length ? <section className="chooser-group singles">
            {groups.length ? <header className="chooser-group-head"><h3>Single videos</h3><span>Drag one onto another, or onto a Studio project, to group them</span></header> : null}
            <div className="chooser-grid">{singles.map(p => card(p, [], undefined))}</div>
          </section> : null}
          {projects && !rows.length ? <div className="chooser-empty">{query ? <><strong>No projects match “{query}”</strong><span>Try another word from the title.</span></>
            : <><strong>No videos yet</strong><span>Record your app, slides and camera in one take, or start from a blank canvas. No recording needed for a new video: add titles, images and motion, or describe the video and let your agent build it.</span></>}</div> : null}
        </div>
        <footer className="chooser-foot">
          <span>{chosen ? <>Selected: <b title={chosen.title}>{chosen.title}</b></> : 'Double-click a video to open it'}</span>
          {canClose && chosen?.id !== currentProjectId ? <button title="Back to the video open now (Esc)" onClick={close}>Back to the video</button> : null}
          <button className="primary" disabled={!chosen || disabled} onClick={() => chosen && open(chosen.id)}>{chosen?.id === currentProjectId ? 'Back to the video' : 'Open'}</button>
        </footer>
      </section>
    </section>
  </div>;
}
