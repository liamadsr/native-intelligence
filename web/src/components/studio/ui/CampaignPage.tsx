import { assetHref } from '@/lib/studio/engine/asset-base';
// A project's overview (a campaign: many ads with the same people, brand and media). Its ads with their formats and
// status; what they share (cast, brand); and notes (the brief, the client's feedback). Opened from the side rail.
import React, { useCallback, useEffect, useState } from 'react';
import type { AdStatus, CampaignSummary } from '@/lib/studio/engine/api';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { exportPresets } from '@/lib/studio/engine/formats';
import { remove, request } from './client';
import { isMenuKey, useContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './icons';
import { adShapes, ratio, statusLabel } from './project-shapes';
import { BrandKitPanel } from './BrandKitPanel';
import { StaticAdsSection } from './StaticAdsSection';

type Ad = CampaignSummary['ads'][number];
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const FORMATS = ['instagram-feed', 'square', 'youtube', 'tiktok'];

export function CampaignPage({ project, openAd, editCast, notify, refreshKey }: { project: EditorProject; openAd: (id: string) => void; editCast: () => void; notify: (text: string, error?: boolean) => void; refreshKey: string }) {
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null), [busy, setBusy] = useState(false);
  const [title, setTitle] = useState<string | null>(null), [notes, setNotes] = useState<string | null>(null);
  const openMenu = useContextMenu();
  const load = useCallback(async () => { try { setCampaign((await request<{ campaign: CampaignSummary }>(`/api/account/studio/campaigns/for/${encodeURIComponent(project.id)}`)).campaign); } catch (e) { notify((e as Error).message, true); } }, [project.id, notify]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  // Ads move on the Projects screen and the assistant makes new ones: catch up when the window comes back.
  useEffect(() => { const again = () => void load(); window.addEventListener('focus', again); return () => window.removeEventListener('focus', again); }, [load]);
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); try { await fn(); await load(); } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); } };
  const update = (patch: Record<string, unknown>) => campaign && act(async () => { await request(`/api/account/studio/campaigns/${encodeURIComponent(campaign.id)}`, patch); });
  if (!campaign) return <div className="film-page project-page"><div className="film-main"><p className="project-loading">Loading the project…</p></div></div>;

  const roots = campaign.ads.filter(a => !a.variantOf), outputs = (ad: Ad) => campaign.ads.filter(a => a.variantOf === ad.id);
  const cast = project.storyboard?.cast ?? [], photo = (assetId?: string) => project.assets.find(a => a.id === assetId);
  const newAd = (event: React.MouseEvent) => openMenu(event, [
    ...adShapes.map(shape => ({ label: `Blank ${shape.label}`, run: () => void act(async () => { const { project: made } = await request<{ project: { id: string } }>(`/api/account/studio/campaigns/${encodeURIComponent(campaign.id)}/new-ad`, { width: shape.width, height: shape.height, title: `${campaign.title} · new ad` }); openAd(made.id); }) })),
    { separator: true },
    { label: `Copy of ${project.title}`, run: () => void act(async () => { const { project: made } = await request<{ project: { id: string } }>(`/api/account/studio/campaigns/${encodeURIComponent(campaign.id)}/new-ad`, { from: project.id }); openAd(made.id); }) },
  ]);
  const adMenu = (event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault?: () => void }, ad: Ad) => {
    const items: MenuItem[] = [
      { label: ad.id === project.id ? 'Edit' : 'Open', run: () => openAd(ad.id), hint: '↵' },
      { label: 'Duplicate as a new ad', run: () => void act(async () => { await request(`/api/account/studio/campaigns/${encodeURIComponent(campaign.id)}/new-ad`, { from: ad.id }); }) },
      { separator: true },
      ...(campaign.single ? [] : (['draft', 'review', 'approved'] as AdStatus[]).map(status => ({ label: `Mark as ${statusLabel[status].toLowerCase()}`, disabled: ad.status === status,
        run: () => void act(async () => { await request(`/api/account/studio/projects/${encodeURIComponent(ad.id)}/status`, { status }); }) }))),
      { separator: true },
      ...exportPresets.filter(p => FORMATS.includes(p.id) && ratio(p.width, p.height) !== ratio(ad.width, ad.height)).map(p => ({ label: `Make ${/^[aeiou]/i.test(p.label) ? 'an' : 'a'} ${p.label} version`,
        run: () => void act(async () => { const r = await request<{ warnings: string[] }>(`/api/account/studio/projects/${encodeURIComponent(ad.variantOf ?? ad.id)}/formats`, { preset: p.id }); notify(r.warnings.length ? `${p.label} made: ${r.warnings[0]}` : `${p.label} version made`); }) })),
      { separator: true },
      ...(!campaign.single && ad.id !== project.id ? [{ label: 'Take out of this project', run: () => void act(async () => { await request(`/api/account/studio/projects/${encodeURIComponent(ad.id)}/unfile`, {}); }) }] : []),
      ...(ad.id !== project.id ? [{ label: 'Delete…', danger: true, run: () => void act(async () => { await remove(`/api/account/studio/projects/${encodeURIComponent(ad.id)}`); }), confirm: { text: `Delete “${ad.title}”? It moves to the trash folder.`, action: 'Delete' } }] : []),
    ];
    openMenu(event, items);
  };
  const card = (ad: Ad) => <article key={ad.id} className={`project-ad${ad.id === project.id ? ' current' : ''}`} tabIndex={0} aria-label={ad.title}
    onClick={() => openAd(ad.id)} onContextMenu={e => adMenu(e, ad)}
    onKeyDown={e => { if (e.key === 'Enter') openAd(ad.id); else if (isMenuKey(e)) { e.preventDefault(); adMenu({ clientX: 0, clientY: 0, currentTarget: e.currentTarget }, ad); } }}>
    <span className="project-ad-thumb" style={{ aspectRatio: `${ad.width} / ${ad.height}` }}><img alt="" loading="lazy" src={`/api/account/studio/projects/${encodeURIComponent(ad.id)}/thumbnail.jpg?v=${encodeURIComponent(ad.updatedAt)}`} onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} /></span>
    <div className="project-ad-text">
      <strong title={ad.title}>{ad.title}</strong>
      <span>{ratio(ad.width, ad.height)} · {clock(ad.durationSeconds)}{ad.id === project.id ? ' · open now' : ''}</span>
      <span className="project-ad-tags">
        {!campaign.single ? <em className={`project-status ${ad.status}`}>{statusLabel[ad.status]}</em> : null}
        {outputs(ad).map(o => <button key={o.id} className="project-output" title={`Open the ${ratio(o.width, o.height)} version`} onClick={e => { e.stopPropagation(); openAd(o.id); }} onContextMenu={e => { e.stopPropagation(); adMenu(e, o); }}>{ratio(o.width, o.height)}</button>)}
      </span>
    </div>
  </article>;

  return <div className="film-page project-page"><div className="film-main project-main">
    <header className="project-head">
      <span className="project-kicker">{campaign.single ? 'Video' : 'Project'}</span>
      {title !== null ? <input className="project-title-input" autoFocus value={title} maxLength={160} aria-label="Project name" onChange={e => setTitle(e.target.value)}
          onBlur={() => { const t = title.trim(); setTitle(null); if (t && t !== campaign.title) void update({ title: t }); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setTitle(null); }} />
        : <h1 title="Click to rename" onClick={() => setTitle(campaign.title)}>{campaign.title}</h1>}
      <p>{roots.length} ad{roots.length === 1 ? '' : 's'}{campaign.ads.length > roots.length ? ` · ${campaign.ads.length - roots.length} more format${campaign.ads.length - roots.length === 1 ? '' : 's'}` : ''}
        {campaign.single ? ' · add another ad to make this a project of several' : ''}</p>
    </header>

    <section className="project-section">
      <div className="project-section-head"><h2>Ads</h2><button className="project-new" disabled={busy} onClick={newAd}><Icon name="plus" size={14} />New ad</button></div>
      <div className="project-ads">{roots.map(card)}</div>
    </section>

    {campaign.single ? null : <StaticAdsSection projectId={campaign.id} refreshKey={`${refreshKey}|${campaign.updatedAt}`} />}

    <div className="project-shared">
      <section className="project-panel">
        <div className="project-section-head"><h2>Cast</h2><button className="project-link" onClick={editCast}>Edit cast</button></div>
        {cast.length ? <div className="project-cast">{cast.map(c => { const a = photo(c.assetIds[0]); return <figure key={c.id}>{a ? <img src={assetHref(a.file)} alt="" /> : <span />}<figcaption>{c.name}<small>{c.kind === 'person' ? 'Person' : c.kind === 'prop' ? 'Prop' : 'Location'}</small></figcaption></figure>; })}</div>
          : <p className="project-empty">No cast yet. People, props and places added in Cast are shared by every ad in this project.</p>}
      </section>
      <BrandKitPanel campaign={campaign} notify={notify} onChanged={() => void load()} />
      <section className="project-panel notes">
        <div className="project-section-head"><h2>Notes</h2></div>
        <textarea value={notes ?? campaign.notes ?? ''} placeholder="The brief, the client's feedback, what's approved…" onChange={e => setNotes(e.target.value)}
          onBlur={() => { if (notes !== null && notes !== (campaign.notes ?? '')) void update({ notes }); setNotes(null); }} />
      </section>
    </div>
  </div></div>;
}
